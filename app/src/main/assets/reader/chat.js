// Talk to Lumi about the book. Bring-your-own-key: the reader pastes their own Claude API key, which stays on this
// device (localStorage) and is sent straight to api.anthropic.com. Lumi only ever sees the text up to where the
// reader is, so she can't spoil what comes next.
import { lumiHTML, setPose } from './companion.js'

const API = 'https://api.anthropic.com/v1/messages'
const VERSION = '2026-10-21'
const KEY = 'lumi.chat.key', MODEL = 'lumi.chat.model', HIST = 'lumi.chat.h.'
const EXCERPT_LIMIT = 9000
export const MODELS = [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', note: 'sharpest' },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', note: 'balanced' },
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5', note: 'fastest, cheapest' },
]
const ls = { get: k => { try { return localStorage.getItem(k) } catch { return null } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* ignore */ } } }

export const chatConfig = {
    get key() { return ls.get(KEY) || '' }, set key(v) { ls.set(KEY, v ? v.trim() : null) },
    get model() { return MODELS.some(m => m.id === ls.get(MODEL)) ? ls.get(MODEL) : MODELS[0].id }, set model(v) { ls.set(MODEL, v) },
    history(bookId) { try { return JSON.parse(ls.get(HIST + bookId) || '[]') } catch { return [] } },
    saveHistory(bookId, msgs) { ls.set(HIST + bookId, msgs.length ? JSON.stringify(msgs.slice(-40)) : null) },
}

export class ChatError extends Error { constructor(status, message) { super(message || `request failed (${status})`); this.status = status } }

/** Lumi's standing instructions for one book, built from where the reader is right now. */
export const persona = ({ title, author, fraction = 0, chapter = '', excerpt = '', highlights = [], words = [] }) => {
    const pct = Math.round(fraction * 100)
    const parts = [
        `You are Lumi, a small, warm reading companion who lives inside an e-book reader app. You sit in the corner of the page and read along with the reader. They are partway through a book and want to talk about it with you.`,
        `Book: "${title || 'untitled'}"${author ? ` by ${author}` : ''}\nReader's position: ${pct}% through${chapter ? `, in "${chapter}"` : ''}.`,
        excerpt ? `This is the text the reader has read most recently, ending exactly where they are now:\n<excerpt>\n${excerpt}\n</excerpt>` : `The reader's current page could not be read, so you only know the title.`,
        highlights.length ? `Passages they highlighted:\n${highlights.map(h => `- "${h}"`).join('\n')}` : '',
        words.length ? `Words they saved to their vocabulary: ${words.join(', ')}` : '',
        `How to be Lumi:
- Talk like a friend who is reading the same book: warm, curious, a little playful, plain words. Lowercase is fine. No emojis, no headings, no bullet lists unless the reader asks for a list or a quiz.
- Keep it short: usually one to four sentences. Go longer only when they ask for depth, a summary or a quiz.
- Stay inside what they have read. The excerpt is your window. You may use general knowledge about the author, the period or the ideas, but NEVER reveal, hint at, foreshadow or speculate about plot, characters, twists or the ending beyond the reader's current position, even if you know the book well and even if they ask. If they ask, say you won't spoil it and offer to talk about what they've read so far instead.
- If something isn't in the excerpt and can't be known from what they've read, say so instead of guessing. Never invent quotes; when you quote, quote the excerpt exactly and briefly.
- For a quiz, ask one question at a time and wait for the answer.
- Reply in the language the reader writes in.`,
    ]
    return parts.filter(Boolean).join('\n\n')
}

/** Streams one reply from Claude. Yields { text } deltas and finally { stop } with the stop reason. */
export async function* stream({ key, model, system, messages, signal, fetchFn = fetch }) {
    const headers = {
        'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
    }
    const body = {
        model, max_tokens: 1024, stream: true,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages, output_config: { effort: 'low' },
    }
    // a safety-classifier decline is re-run server-side on the model Anthropic recommends (not offered for Haiku)
    if (!model.includes('haiku')) { body.fallbacks = 'default'; headers['anthropic-beta'] = 'server-side-fallback-2026-07-01' }
    const res = await fetchFn(API, { method: 'POST', headers, body: JSON.stringify(body), signal })
    if (!res.ok) {
        let msg = ''
        try { msg = (await res.json()).error?.message || '' } catch { /* ignore */ }
        throw new ChatError(res.status, msg)
    }
    const reader = res.body.getReader(), dec = new TextDecoder()
    let buf = ''
    for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data:')) continue
                let ev; try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
                if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') yield { text: ev.delta.text }
                else if (ev.type === 'message_delta' && ev.delta?.stop_reason) yield { stop: ev.delta.stop_reason }
                else if (ev.type === 'error') throw new ChatError(0, ev.error?.message)
            }
        }
    }
}

const SUGGEST = ['what just happened?', 'who’s who so far?', 'explain this part simply', 'quiz me on this chapter', 'why does this matter?']
const SUGGEST_QUOTE = ['what does this passage mean?', 'why is this line here?', 'say it in plain words']
const friendly = e => {
    if (e.name === 'AbortError') return ''
    if (e.status === 401) return 'that key didn’t work. check it in settings?'
    if (e.status === 403) return 'that key isn’t allowed to do this.'
    if (e.status === 429) return 'too many questions at once, give it a moment.'
    if (e.status === 529 || e.status === 503) return 'claude is busy right now, try again in a bit.'
    if (e.status === 0 || e instanceof TypeError) return 'can’t reach claude. are you online?'
    return e.message ? `hmm: ${e.message}` : 'something went wrong.'
}
const squash = s => String(s ?? '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()

export class LumiChat {
    /**
     * @param {HTMLElement} root  the #chat-panel element
     * @param {{ getContext: () => Promise<object>, bookId: string, open: () => void, close: () => void, openExternal?: (url: string) => void, onThinking?: (on: boolean) => void }} opts
     */
    constructor(root, opts) {
        this.root = root; this.opts = opts
        this.q = s => root.querySelector(s)
        this.log = this.q('#chat-log'); this.input = this.q('#chat-input'); this.chips = this.q('#chat-chips'); this.setup = this.q('#chat-setup')
        this.q('.chat-who').insertAdjacentHTML('afterbegin', lumiHTML('reading', 'chat-lumi'))
        this.figure = this.q('.chat-lumi')
        this.messages = chatConfig.history(opts.bookId)
        this.quote = null; this.busy = false
        this.q('#chat-form').addEventListener('submit', e => { e.preventDefault(); this.send(this.input.value) })
        this.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(this.input.value) } })
        this.input.addEventListener('input', () => this.#grow())
        this.q('#chat-settings').addEventListener('click', () => this.showSetup(this.setup.hidden))
        this.q('#chat-key-save').addEventListener('click', () => this.#saveSetup())
        this.q('#chat-key').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.#saveSetup() } })
        this.q('#chat-key-forget').addEventListener('click', () => { chatConfig.key = null; this.toast?.('key forgotten'); this.render(); this.showSetup(true) })
        this.q('#chat-clear').addEventListener('click', () => this.clear())
        this.q('#chat-key-link').addEventListener('click', e => { e.preventDefault(); (opts.openExternal || (u => window.open(u, '_blank')))(e.currentTarget.href) })
        this.q('#chat-models').innerHTML = MODELS.map(m => `<button type="button" class="chip" data-model="${m.id}">${m.name}<small>${m.note}</small></button>`).join('')
        this.q('#chat-models').addEventListener('click', e => { const b = e.target.closest('[data-model]'); if (b) { chatConfig.model = b.dataset.model; this.#syncModels() } })
        this.q('#chat-quote-x').addEventListener('click', () => this.setQuote(null))
        this.log.addEventListener('click', e => { const r = e.target.closest('[data-retry]'); if (r) { this.input.value = r.dataset.retry; r.closest('.msg').remove(); this.send(this.input.value) } })
        this.render()
    }
    get ready() { return !!chatConfig.key }
    /** Opens the sheet, optionally about a passage the reader picked. */
    open(quote = null) {
        if (quote) this.setQuote(quote)
        this.opts.open()
        this.showSetup(!this.ready)
        if (this.ready && !quote) setTimeout(() => this.input.focus({ preventScroll: true }), 350)
        this.#scroll()
    }
    setQuote(text) {
        this.quote = text ? squash(text).slice(0, 600) : null
        const pill = this.q('#chat-quote'); pill.hidden = !this.quote
        this.q('#chat-quote-text').textContent = this.quote || ''
        this.#renderChips()
    }
    showSetup(v) {
        this.setup.hidden = !v
        if (v) { this.q('#chat-key').value = chatConfig.key; this.#syncModels(); this.q('#chat-key-forget').hidden = !this.ready; if (!this.ready) setTimeout(() => this.q('#chat-key').focus({ preventScroll: true }), 350) }
        this.q('#chat-form').classList.toggle('dim', v)
    }
    #syncModels() { for (const b of this.q('#chat-models').children) b.classList.toggle('active', b.dataset.model === chatConfig.model) }
    #saveSetup() {
        const k = this.q('#chat-key').value.trim()
        if (!k) { this.toast?.('paste a key first'); return }
        if (!/^sk-ant-/.test(k)) { this.toast?.('that doesn’t look like a claude api key'); return }
        chatConfig.key = k; this.showSetup(false); this.render(); this.toast?.('key saved on this device')
        setTimeout(() => this.input.focus({ preventScroll: true }), 100)
    }
    clear() {
        this.messages = []; chatConfig.saveHistory(this.opts.bookId, []); this.setQuote(null); this.render(); this.showSetup(false)
    }
    render() {
        this.log.innerHTML = ''
        if (!this.messages.length) {
            const hello = document.createElement('div'); hello.className = 'chat-hello'
            hello.textContent = this.ready ? 'ask me anything about what you’ve read so far. i won’t spoil what’s ahead.' : 'i can chat about the book once you give me a key.'
            this.log.append(hello)
        }
        for (const m of this.messages) this.#bubble(m.role, m.content)
        this.#renderChips(); this.#scroll()
    }
    #renderChips() {
        const list = this.quote ? SUGGEST_QUOTE : (this.messages.length ? SUGGEST.slice(0, 3) : SUGGEST)
        this.chips.innerHTML = list.map(s => `<button type="button" class="chip">${s}</button>`).join('')
        for (const b of this.chips.children) b.addEventListener('click', () => this.send(b.textContent))
    }
    #bubble(role, text, cls = '') {
        const el = document.createElement('div'); el.className = `msg ${role} ${cls}`.trim()
        const body = document.createElement('div'); body.className = 'msg-body'; el.append(body)
        this.#fill(body, text); this.log.append(el); return body
    }
    #fill(body, text) {
        body.innerHTML = ''
        const paras = String(text).split(/\n{2,}/)
        for (const p of paras) { const el = document.createElement('p'); el.textContent = p; body.append(el) }
    }
    #scroll() { requestAnimationFrame(() => { this.log.scrollTop = this.log.scrollHeight }) }
    #grow() { this.input.style.height = 'auto'; this.input.style.height = Math.min(120, this.input.scrollHeight) + 'px' }
    async send(text) {
        text = String(text ?? '').trim()
        if (!text || this.busy) return
        if (!this.ready) { this.showSetup(true); return }
        const quote = this.quote
        const content = quote ? `About this passage: "${quote}"\n\n${text}` : text
        this.input.value = ''; this.#grow(); this.setQuote(null)
        this.log.querySelector('.chat-hello')?.remove()
        if (quote) { const b = this.#bubble('user', text); const q = document.createElement('blockquote'); q.textContent = quote; b.prepend(q) } else this.#bubble('user', text)
        const reply = this.#bubble('assistant', '', 'typing'); reply.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'
        this.#scroll()
        this.busy = true; this.root.classList.add('busy'); setPose(this.figure, 'thinking'); this.opts.onThinking?.(true)
        this.abort = new AbortController()
        let out = '', stop = null
        try {
            const ctx = await this.opts.getContext()
            const system = persona(ctx)
            const history = [...this.messages.slice(-20), { role: 'user', content }]
            for await (const ev of stream({ key: chatConfig.key, model: chatConfig.model, system, messages: history, signal: this.abort.signal })) {
                if (ev.text) { out += ev.text; reply.classList.remove('typing'); this.#fill(reply, out); this.#scroll() }
                if (ev.stop) stop = ev.stop
            }
            if (stop === 'refusal' && !out.trim()) out = 'hmm, that’s one i can’t get into. ask me something else about the book?'
            if (!out.trim()) out = '…i lost my train of thought. ask again?'
            this.#fill(reply, out)
            this.messages.push({ role: 'user', content }, { role: 'assistant', content: out })
            chatConfig.saveHistory(this.opts.bookId, this.messages)
            setPose(this.figure, 'happy'); this.figure.classList.add('is-happy'); setTimeout(() => { this.figure.classList.remove('is-happy'); setPose(this.figure, 'reading') }, 1400)
        } catch (e) {
            console.warn('chat', e)
            const msg = friendly(e)
            if (!msg) { reply.closest('.msg').remove() } else {
                reply.closest('.msg').classList.add('error'); reply.classList.remove('typing')
                reply.innerHTML = ''; const p = document.createElement('p'); p.textContent = msg; reply.append(p)
                const r = document.createElement('button'); r.type = 'button'; r.className = 'mini'; r.dataset.retry = text; r.textContent = 'try again'; reply.append(r)
                if (e.status === 401) this.showSetup(true)
            }
            setPose(this.figure, 'reading')
        } finally {
            this.busy = false; this.root.classList.remove('busy'); this.opts.onThinking?.(false); this.#renderChips(); this.#scroll()
        }
    }
    stop() { this.abort?.abort() }
}
