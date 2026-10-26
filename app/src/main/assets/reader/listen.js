// Read-aloud with the device's voices. Sentences are spoken one at a time so the
// current one can be highlighted on every platform (iOS sends no boundary events).

const segmentSentences = (text, lang = 'en') => {
    const out = []
    try {
        const seg = new Intl.Segmenter(lang, { granularity: 'sentence' })
        for (const s of seg.segment(text)) if (s.segment.trim()) out.push({ start: s.index, end: s.index + s.segment.length, text: s.segment.trim() })
    } catch {
        let i = 0
        for (const m of text.matchAll(/[^.!?]+[.!?]*\s*/g)) { if (m[0].trim()) out.push({ start: m.index, end: m.index + m[0].length, text: m[0].trim() }); i++ }
    }
    return out
}

const parseSSML = ssml => {
    const doc = new DOMParser().parseFromString(ssml, 'application/xml')
    const segments = []
    let name = null, buf = ''
    const flush = () => { const t = buf.replace(/\s+/g, ' ').trim(); if (t) segments.push({ name, text: t }); buf = '' }
    const walk = node => {
        for (const n of node.childNodes) {
            if (n.nodeType === 3) buf += n.data
            else if (n.nodeType === 1 && n.localName === 'mark') { flush(); name = n.getAttribute('name') }
            else if (n.nodeType === 1) walk(n)
        }
    }
    walk(doc.documentElement)
    flush()
    return segments
}

export class Listener extends EventTarget {
    constructor({ view = null, pdf = null, lang = 'en', onHighlight = () => {} }) {
        super()
        this.view = view; this.pdf = pdf; this.lang = lang; this.onHighlight = onHighlight
        this.state = 'idle'
        this.rate = +(localStorage.getItem('dogear.listen.rate') || 1)
        this.queue = []; this.pos = 0
        this.synth = globalThis.speechSynthesis
    }
    get supported() { return !!this.synth && 'SpeechSynthesisUtterance' in globalThis }

    // iOS: speech output follows the ringer switch unless a media element is playing, which moves the
    // page to the "playback" audio session. A looping second of silence does that while we read aloud.
    #silentAudio() {
        const sr = 8000, n = 8000, buf = new Uint8Array(44 + n), dv = new DataView(buf.buffer)
        const str = (o, t) => { for (let i = 0; i < t.length; i++) buf[o + i] = t.charCodeAt(i) }
        str(0, 'RIFF'); dv.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true)
        dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr, true)
        dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); str(36, 'data'); dv.setUint32(40, n, true); buf.fill(128, 44)
        const a = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })))
        a.loop = true; a.setAttribute('playsinline', ''); a.preload = 'auto'
        return a
    }
    #audioOn() { try { this.keepAlive ??= this.#silentAudio(); this.keepAlive.play()?.catch?.(() => {}) } catch { /* no audio element support */ } }
    #audioOff() { try { this.keepAlive?.pause() } catch { /* ignore */ } }
    // iOS only speaks if the first utterance of a page is queued inside a user gesture; our start() awaits before
    // the first real sentence, so queue a silent one synchronously here.
    #prime() { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; this.synth.speak(u) } catch { /* ignore */ } }
    // cancel() immediately followed by speak() drops the utterance on iOS; restart after a tick.
    #restart(manual) { this.synth.cancel(); clearTimeout(this.restartTimer); this.restartTimer = setTimeout(() => this.#speakCurrent(manual), 80) }

    #setState(s) { this.state = s; this.dispatchEvent(new CustomEvent('state', { detail: s })) }

    setRate(r) { this.rate = Math.min(2, Math.max(0.5, r)); localStorage.setItem('dogear.listen.rate', String(this.rate)); if (this.state === 'playing') this.#restart(false) }

    async start() {
        if (!this.supported) throw new Error('This device has no text-to-speech voices.')
        this.#audioOn()
        if (this.synth.speaking || this.synth.pending) this.synth.cancel(); else this.#prime()
        if (this.pdf) await this.#loadPdfPage(this.pdf.current)
        else await this.#loadSection(true)
        if (!this.queue.length) { this.stop(); return }
        this.#setState('playing')
        this.#speakCurrent()
    }
    pause() { if (this.state !== 'playing') return; this.synth.cancel(); this.#audioOff(); this.#setState('paused') }
    resume() { if (this.state !== 'paused') return; this.#audioOn(); this.#setState('playing'); this.#speakCurrent() }
    toggle() { this.state === 'playing' ? this.pause() : this.state === 'paused' ? this.resume() : this.start() }
    stop() { clearTimeout(this.restartTimer); clearTimeout(this.watchdog); this.synth?.cancel(); this.#audioOff(); this.queue = []; this.pos = 0; this.onHighlight(null); this.#setState('idle') }
    next() { if (this.state === 'idle') return; this.pos++; this.#restart(true) }
    prev() { if (this.state === 'idle') return; this.pos = Math.max(0, this.pos - 1); this.#restart(true) }

    // ----- reflowable books (foliate) -----
    async #loadSection(fromVisible) {
        const { TTS } = await import('./foliate/tts.js')
        const { textWalker } = await import('./foliate/text-walker.js')
        const content = this.view.renderer.getContents()[0]
        if (!content) { this.queue = []; return }
        this.doc = content.doc; this.index = content.index
        this.tts = new TTS(this.doc, textWalker, range => this.onHighlight(range), 'sentence')
        const range = fromVisible ? this.view.lastLocation?.range : null
        let ssml = null
        try { ssml = range && range.startContainer.getRootNode() === this.doc ? this.tts.from(range) : this.tts.start() } catch { ssml = this.tts.start() }
        this.queue = ssml ? parseSSML(ssml) : []
        this.pos = 0
    }
    async #nextBlock() {
        const ssml = this.tts?.next()
        if (ssml) { this.queue = parseSSML(ssml); this.pos = 0; return this.queue.length > 0 || this.#nextBlock() }
        // end of section → next section
        const total = this.view.book.sections.length
        let idx = this.index + 1
        while (idx < total && this.view.book.sections[idx].linear === 'no') idx++
        if (idx >= total) return false
        await this.view.goTo(idx)
        await new Promise(r => setTimeout(r, 150))
        await this.#loadSection(false)
        return this.queue.length > 0 || this.#nextBlock()
    }

    // ----- PDF -----
    async #loadPdfPage(n) {
        if (n > this.pdf.total) { this.queue = []; return }
        this.page = n
        const page = await this.pdf.pdf.getPage(n)
        const tc = await page.getTextContent()
        let text = ''; const spans = []
        for (const item of tc.items) { spans.push({ start: text.length, end: text.length + item.str.length }); text += item.str + (item.hasEOL ? '\n' : ' ') }
        this.pdfSpans = spans
        this.queue = segmentSentences(text, this.lang).map(s => ({ name: null, text: s.text, start: s.start, end: s.end }))
        this.pos = 0
        if (this.pdf.current !== n) this.pdf.goToPage(n)
    }
    #highlightPdf(seg) {
        const idx = []
        this.pdfSpans.forEach((sp, i) => { if (sp.end > seg.start && sp.start < seg.end) idx.push(i) })
        this.onHighlight({ page: this.page, spanIndices: idx })
    }

    // ----- speaking -----
    async #speakCurrent(manual = false) {
        if (this.state !== 'playing' && !manual) return
        if (this.pos >= this.queue.length) {
            const more = this.pdf ? (await this.#loadPdfPage(this.page + 1), this.queue.length > 0) : await this.#nextBlock()
            if (!more) { this.stop(); this.dispatchEvent(new Event('done')); return }
        }
        if (this.pos < 0) this.pos = 0
        const seg = this.queue[this.pos]
        if (!seg) { this.stop(); return }
        if (this.pdf) this.#highlightPdf(seg); else if (seg.name) this.tts.setMark(seg.name)
        this.dispatchEvent(new CustomEvent('segment', { detail: seg }))
        if (manual && this.state !== 'playing') this.#setState('playing')
        const u = new SpeechSynthesisUtterance(seg.text)
        u.rate = this.rate; u.lang = this.lang || 'en'
        const voice = this.#voice()
        if (voice) u.voice = voice
        const advance = () => { if (this.state === 'playing' && this.current === u) { clearTimeout(this.watchdog); this.pos++; this.#speakCurrent() } }
        u.onend = advance
        u.onerror = e => {
            if (e.error === 'interrupted' || e.error === 'canceled') return
            console.warn('tts', e.error)
            if (e.error === 'not-allowed' || e.error === 'audio-busy' || e.error === 'synthesis-unavailable') { this.stop(); this.dispatchEvent(new CustomEvent('error', { detail: e.error })); return }
            advance()
        }
        this.current = u
        this.synth.speak(u)
        // iOS sometimes never fires onend (screen lock, interruptions); move on once the sentence must be over
        clearTimeout(this.watchdog)
        const expect = () => { if (this.current !== u || this.state !== 'playing') return; if (this.synth.speaking) { this.watchdog = setTimeout(expect, 2000); return } advance() }
        this.watchdog = setTimeout(expect, seg.text.length * 100 / this.rate + 2500)
    }
    #voice() {
        const voices = this.synth.getVoices?.() || []
        const want = (this.lang || 'en').toLowerCase()
        return voices.find(v => v.lang.toLowerCase() === want && v.localService) || voices.find(v => v.lang.toLowerCase().startsWith(want.split('-')[0]) && v.localService)
            || voices.find(v => v.lang.toLowerCase().startsWith(want.split('-')[0])) || null
    }
}
