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

/** Strips things that should not be read aloud: footnote markers, superscript digits, stray markdown emphasis; turns dashes into pauses. */
export const cleanForSpeech = t => t
    .replace(/\[\d{1,3}\]/g, '')
    .replace(/[\u00B9\u00B2\u00B3\u2070-\u2079]+/g, '')
    .replace(/\s[*_]{1,3}\s/g, ' ')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/\s{2,}/g, ' ').trim()
const speakable = t => t && !/^[\d\s.,;:!?'"()\-]*$/.test(t)

const parseSSML = ssml => {
    const doc = new DOMParser().parseFromString(ssml, 'application/xml')
    const segments = []
    let name = null, buf = ''
    const flush = () => { const t = cleanForSpeech(buf.replace(/\s+/g, ' ')); if (speakable(t)) segments.push({ name, text: t }); buf = '' }
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
        this.voiceFailed = false
        try { this.synth?.addEventListener?.('voiceschanged', () => this.dispatchEvent(new Event('voices'))) } catch { /* ignore */ }
    }

    // ----- voices -----
    get #langKey() { return (this.lang || 'en').toLowerCase().split(/[-_]/)[0] }
    /** Installed voices for the book's language, best first. */
    voices() {
        const want = this.#langKey
        const quality = v => /premium/i.test(v.name) ? 'premium' : /enhanced|neural|wavenet|natural/i.test(v.name) ? 'enhanced' : v.localService === false ? 'online' : ''
        const rank = q => ({ premium: 3, enhanced: 2, '': 1, online: 0 })[q]
        return (this.synth.getVoices?.() || [])
            .filter(v => (v.lang || '').toLowerCase().replace('_', '-').startsWith(want))
            .map(v => ({ uri: v.voiceURI, name: v.name, lang: v.lang, quality: quality(v) }))
            .sort((a, b) => rank(b.quality) - rank(a.quality) || a.name.localeCompare(b.name))
    }
    get voiceURI() { return localStorage.getItem('dogear.listen.voice.' + this.#langKey) || '' }
    setVoice(uri) {
        const key = 'dogear.listen.voice.' + this.#langKey
        if (uri) localStorage.setItem(key, uri); else localStorage.removeItem(key)
        this.voiceFailed = false
        if (this.state === 'playing') this.#restart(false)
    }
    #voice() {
        if (this.voiceFailed) return null
        const uri = this.voiceURI
        return uri ? (this.synth.getVoices?.() || []).find(v => v.voiceURI === uri) || null : null
    }
    /** Speaks one sample sentence with the chosen voice (pauses reading first). */
    preview(text) {
        if (this.state === 'playing') this.pause()
        this.synth.cancel()
        const u = new SpeechSynthesisUtterance(text)
        u.rate = this.rate; u.lang = this.lang || 'en'
        const v = this.#voice(); if (v) u.voice = v
        this.previewUtterance = u
        setTimeout(() => this.synth.speak(u), 80)
    }
    get supported() { return !!this.synth && 'SpeechSynthesisUtterance' in globalThis }

    // The foliate text-to-speech helpers are loaded ahead of time so that start() can reach its first
    // speak() synchronously inside the user's tap: iOS refuses the first utterance of a page otherwise.
    static mods = null
    static preload() { return Listener.mods ??= Promise.all([import('./foliate/tts.js'), import('./foliate/text-walker.js')]).then(([a, b]) => (Listener.loaded = { TTS: a.TTS, textWalker: b.textWalker })) }
    // When the text cannot be ready synchronously (PDF pages, first use), an empty utterance queued in the tap unlocks speech.
    #prime() { try { this.synth.speak(new SpeechSynthesisUtterance('')) } catch { /* ignore */ } }
    // iOS leaves the synthesizer "paused" after interruptions; nothing plays until it is resumed.
    #unstick() { try { if (this.synth.paused) this.synth.resume() } catch { /* ignore */ } }
    // cancel() immediately followed by speak() drops the utterance on iOS; restart after a tick.
    #restart(manual) { this.synth.cancel(); clearTimeout(this.restartTimer); this.restartTimer = setTimeout(() => this.#speakCurrent(manual), 80) }

    #setState(s) { this.state = s; this.dispatchEvent(new CustomEvent('state', { detail: s })) }

    setRate(r) { this.rate = Math.min(2, Math.max(0.5, r)); localStorage.setItem('dogear.listen.rate', String(this.rate)); if (this.state === 'playing') this.#restart(false) }

    async start() {
        if (!this.supported) throw new Error('This device has no text-to-speech voices.')
        this.#unstick()
        if (this.synth.speaking || this.synth.pending) this.synth.cancel()
        this.stalls = 0
        if (this.pdf) { this.#prime(); await this.#loadPdfPage(this.pdf.current) }
        else if (!this.#loadSectionSync(true)) { this.#prime(); await Listener.preload(); this.#loadSectionSync(true) }
        if (!this.queue.length) { this.stop(); return }
        this.#setState('playing')
        this.#speakCurrent()
    }
    pause() { if (this.state !== 'playing') return; this.synth.cancel(); this.#setState('paused') }
    resume() { if (this.state !== 'paused') return; this.#unstick(); this.#setState('playing'); this.#speakCurrent() }
    toggle() { this.state === 'playing' ? this.pause() : this.state === 'paused' ? this.resume() : this.start() }
    stop() { clearTimeout(this.restartTimer); clearTimeout(this.watchdog); this.synth?.cancel(); this.queue = []; this.pos = 0; this.onHighlight(null); this.#setState('idle') }
    next() { if (this.state === 'idle') return; this.pos++; this.#restart(true) }
    prev() { if (this.state === 'idle') return; this.pos = Math.max(0, this.pos - 1); this.#restart(true) }

    // ----- reflowable books (foliate) -----
    /** Builds the sentence queue from the current section. Returns false when the helpers are not loaded yet. */
    #loadSectionSync(fromVisible) {
        if (!Listener.loaded) { Listener.preload(); return false }
        const { TTS, textWalker } = Listener.loaded
        const content = this.view.renderer.getContents()[0]
        if (!content) { this.queue = []; return true }
        this.doc = content.doc; this.index = content.index
        this.tts = new TTS(this.doc, textWalker, range => this.onHighlight(range), 'sentence')
        const range = fromVisible ? this.view.lastLocation?.range : null
        let ssml = null
        try { ssml = range && range.startContainer.getRootNode() === this.doc ? this.tts.from(range) : this.tts.start() } catch { ssml = this.tts.start() }
        this.queue = ssml ? parseSSML(ssml) : []
        this.pos = 0
        return true
    }
    async #loadSection(fromVisible) { await Listener.preload(); this.#loadSectionSync(fromVisible) }
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
        this.queue = segmentSentences(text, this.lang).map(s => ({ name: null, text: cleanForSpeech(s.text), start: s.start, end: s.end })).filter(s => speakable(s.text))
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
        // Only a voice the reader picked; an automatically chosen voice can be listed yet uninstalled, which plays silence forever.
        const voice = this.#voice()
        if (voice) u.voice = voice
        const advance = () => { if (this.state === 'playing' && this.current === u) { clearTimeout(this.watchdog); this.pos++; this.#speakCurrent() } }
        u.onend = () => { this.stalls = 0; advance() }
        u.onerror = e => {
            if (e.error === 'interrupted' || e.error === 'canceled') return
            console.warn('tts', e.error)
            if (e.error === 'not-allowed' || e.error === 'audio-busy' || e.error === 'synthesis-unavailable') { this.stop(); this.dispatchEvent(new CustomEvent('error', { detail: e.error })); return }
            advance()
        }
        this.current = u
        this.#unstick()
        this.synth.speak(u)
        // Stall guard: when no end event arrives in the time the sentence could possibly take, retry it once
        // (a stuck queue usually clears with cancel + speak); after three stalled sentences in a row, give up loudly.
        clearTimeout(this.watchdog)
        const stalled = () => {
            if (this.current !== u || this.state !== 'playing') return
            if (this.stallAt !== this.pos) { this.stallAt = this.pos; this.stallTries = 0 }
            if (this.stallTries++ < 1) {
                // a chosen voice that never finishes is the usual culprit: retry with the device default
                if (this.#voice()) { this.voiceFailed = true; this.dispatchEvent(new Event('voice-fallback')) }
                this.synth.cancel(); this.#unstick(); setTimeout(() => this.#speakCurrent(true), 150); return
            }
            this.stalls = (this.stalls || 0) + 1
            if (this.stalls >= 3) { this.stop(); this.dispatchEvent(new CustomEvent('error', { detail: 'stalled' })); return }
            advance()
        }
        this.watchdog = setTimeout(stalled, this.stallBudget(seg))
    }
    /** Milliseconds a sentence may take before it counts as stalled. */
    stallBudget(seg) { return seg.text.length * 90 / this.rate + 3000 }
}
