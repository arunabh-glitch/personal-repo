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

    #setState(s) { this.state = s; this.dispatchEvent(new CustomEvent('state', { detail: s })) }

    setRate(r) { this.rate = Math.min(2, Math.max(0.5, r)); localStorage.setItem('dogear.listen.rate', String(this.rate)); if (this.state === 'playing') { this.synth.cancel(); this.#speakCurrent() } }

    async start() {
        if (!this.supported) throw new Error('This device has no text-to-speech voices.')
        this.synth.cancel()
        if (this.pdf) await this.#loadPdfPage(this.pdf.current)
        else await this.#loadSection(true)
        if (!this.queue.length) { this.stop(); return }
        this.#setState('playing')
        this.#speakCurrent()
    }
    pause() { if (this.state !== 'playing') return; this.synth.cancel(); this.#setState('paused') }
    resume() { if (this.state !== 'paused') return; this.#setState('playing'); this.#speakCurrent() }
    toggle() { this.state === 'playing' ? this.pause() : this.state === 'paused' ? this.resume() : this.start() }
    stop() { this.synth?.cancel(); this.queue = []; this.pos = 0; this.onHighlight(null); this.#setState('idle') }
    next() { if (this.state === 'idle') return; this.synth.cancel(); this.pos++; this.#speakCurrent(true) }
    prev() { if (this.state === 'idle') return; this.synth.cancel(); this.pos = Math.max(0, this.pos - 1); this.#speakCurrent(true) }

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
        u.onend = () => { if (this.state === 'playing' && this.current === u) { this.pos++; this.#speakCurrent() } }
        u.onerror = e => { if (e.error === 'interrupted' || e.error === 'canceled') return; console.warn('tts', e.error); if (this.state === 'playing' && this.current === u) { this.pos++; this.#speakCurrent() } }
        this.current = u
        this.synth.speak(u)
    }
    #voice() {
        const voices = this.synth.getVoices?.() || []
        const want = (this.lang || 'en').toLowerCase()
        return voices.find(v => v.lang.toLowerCase() === want && v.localService) || voices.find(v => v.lang.toLowerCase().startsWith(want.split('-')[0]) && v.localService)
            || voices.find(v => v.lang.toLowerCase().startsWith(want.split('-')[0])) || null
    }
}
