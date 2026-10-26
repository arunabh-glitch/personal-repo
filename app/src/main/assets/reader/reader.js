import './foliate/view.js'
import { makeTextBook, isTextFormat } from './text-book.js'
import { createWebBridge } from './web-bridge.js'
import { lookup, speak, selectedPhrase, normalizeWord } from './dictionary.js'
import { Overlayer } from './foliate/overlayer.js'
import { translate, LANGS, defaultTarget } from './translate.js'
import { Listener } from './listen.js'

const $ = s => document.querySelector(s)
const $$ = s => Array.from(document.querySelectorAll(s))

const DEFAULTS = {
    theme: 'light', fontSize: 18, lineHeight: 1.5, margin: 24, fontFamily: 'publisher',
    flow: 'paginated', justify: true, hyphenate: true, pdfZoom: 1, keepScreenOn: false, defineOnSelect: true,
    selectMode: false, translateTo: null,
}
const PRESETS = {
    cosy: { theme: 'sepia', fontFamily: 'serif', fontSize: 19, lineHeight: 1.6, margin: 28, justify: true, flow: 'paginated' },
    focus: { theme: 'light', fontFamily: 'sans-serif', fontSize: 18, lineHeight: 1.5, margin: 32, justify: false, flow: 'paginated' },
    night: { theme: 'dark', fontFamily: 'serif', fontSize: 18, lineHeight: 1.55, margin: 24, justify: true, flow: 'paginated' },
}
const HL_COLORS = { lime: 'rgba(198,242,78,0.6)', pink: 'rgba(255,92,168,0.45)', blue: 'rgba(143,176,255,0.55)', sun: 'rgba(255,210,63,0.6)' }
const uuid = () => crypto.randomUUID?.() ?? String(Date.now()) + Math.random().toString(16).slice(2)
const THEMES = {
    light: { bg: '#fffdf8', fg: '#1e1636', link: '#1a5fb4', dark: false, force: false },
    sepia: { bg: '#f3e7cf', fg: '#3f2f22', link: '#8b4513', dark: false, force: true },
    gray:  { bg: '#2a2724', fg: '#e2dbd0', link: '#8ab4f8', dark: true, force: true },
    dark:  { bg: '#000000', fg: '#d9d2c7', link: '#8ab4f8', dark: true, force: true },
}

// ---------- bridge to the Android host (falls back to browser storage) ----------
let native = globalThis.Android
const params = new URLSearchParams(location.search)
// Web build: a library id in the URL selects the IndexedDB-backed bridge.
const initWebBridge = async () => { if (!native && params.get('id') && !params.get('url')) native = await createWebBridge(params.get('id')) }
const bridge = {
    getBookInfo() {
        if (native) return JSON.parse(native.getBookInfo())
        const url = params.get('url')
        return {
            id: params.get('id') || url, url, fileName: params.get('name') || url?.split('/').pop() || 'book',
            format: params.get('format') || (url || '').split('.').pop().toLowerCase(),
            title: params.get('title') || '', location: localStorage.getItem('loc:' + url) || null,
            needsMetadata: true,
        }
    },
    getSettings() {
        try {
            const raw = native ? native.getSettings() : localStorage.getItem('reader-settings')
            return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) }
        } catch { return { ...DEFAULTS } }
    },
    saveSettings(s) { const j = JSON.stringify(s); native ? native.saveSettings(j) : localStorage.setItem('reader-settings', j) },
    saveProgress(p) { const j = JSON.stringify(p); native ? native.saveProgress(j) : localStorage.setItem('loc:' + params.get('url'), p.location ?? '') },
    onMetadata(m) { const j = JSON.stringify(m); native ? native.onMetadata(j) : console.log('metadata', m.title, m.author, m.cover?.length) },
    onReady() { native?.onReady?.() },
    onError(msg) { native ? native.onError(String(msg)) : console.error(msg) },
    close() { native ? native.close() : history.back() },
    setBarsVisible(v) { native?.setBarsVisible?.(!!v) },
    keepScreenOn(v) { native?.keepScreenOn?.(!!v) },
    openExternal(url) { native ? native.openExternal(url) : window.open(url, '_blank') },
}

// Highlights and sessions live in the host's store (web: IndexedDB via the bridge; Android/test: localStorage).
const hostStore = {
    async list(bookId) {
        if (native?.listHighlights) return JSON.parse(await native.listHighlights()) || []
        try { return JSON.parse(localStorage.getItem('dogear.hl.' + bookId) || '[]') } catch { return [] }
    },
    async save(bookId, h) {
        h.bookId = bookId; h.id ||= uuid(); h.createdAt ||= Date.now()
        if (native?.saveHighlight) { await native.saveHighlight(JSON.stringify(h)); return h }
        const list = (await this.list(bookId)).filter(x => x.id !== h.id); list.push(h)
        localStorage.setItem('dogear.hl.' + bookId, JSON.stringify(list)); return h
    },
    async remove(bookId, id) {
        if (native?.deleteHighlight) return native.deleteHighlight(id)
        localStorage.setItem('dogear.hl.' + bookId, JSON.stringify((await this.list(bookId)).filter(x => x.id !== id)))
    },
    async saveSession(bookId, sess) {
        sess.bookId = bookId
        if (native?.saveSession) return native.saveSession(JSON.stringify(sess))
        try { const all = JSON.parse(localStorage.getItem('dogear.sessions') || '[]').filter(x => x.id !== sess.id); all.push(sess); localStorage.setItem('dogear.sessions', JSON.stringify(all.slice(-500))) } catch { /* ignore */ }
    },
    markFinished() { try { native?.markFinished?.() } catch { /* ignore */ } },
}

const formatContributor = c => {
    if (!c) return ''
    if (Array.isArray(c)) return c.map(formatContributor).filter(Boolean).join(', ')
    if (typeof c === 'string') return c
    const name = c.name
    if (!name) return ''
    return typeof name === 'string' ? name : Object.values(name)[0] ?? ''
}
const formatTitle = t => !t ? '' : typeof t === 'string' ? t : Object.values(t)[0] ?? ''
const percent = new Intl.NumberFormat('en', { style: 'percent' })
const escapeHTML = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const phase = p => { globalThis.__phase = p; console.log('phase: ' + p) }
// Finds the word under a point without selecting anything (so iOS shows no Copy/Look Up bar).
const wordRangeAt = (doc, x, y) => {
    let node, offset
    if (doc.caretRangeFromPoint) { const r = doc.caretRangeFromPoint(x, y); if (!r) return null; node = r.startContainer; offset = r.startOffset }
    else if (doc.caretPositionFromPoint) { const p = doc.caretPositionFromPoint(x, y); if (!p) return null; node = p.offsetNode; offset = p.offset }
    else return null
    if (!node || node.nodeType !== 3) return null
    const text = node.data
    const isW = c => /[\p{L}\p{N}'’\u2019-]/u.test(c)
    let st = offset, en = offset
    while (st > 0 && isW(text[st - 1])) st--
    while (en < text.length && isW(text[en])) en++
    if (en - st < 1 || !/\p{L}/u.test(text.slice(st, en))) return null
    const range = doc.createRange(); range.setStart(node, st); range.setEnd(node, en)
    return range
}
const COARSE = matchMedia('(pointer: coarse)').matches
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }

const blobToDataURL = async (blob, maxH = 600) => {
    try {
        const bmp = await createImageBitmap(blob)
        const s = Math.min(1, maxH / bmp.height)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(bmp.width * s)); canvas.height = Math.max(1, Math.round(bmp.height * s))
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
        bmp.close?.()
        return canvas.toDataURL('image/jpeg', 0.85)
    } catch (e) { console.warn('cover failed', e); return null }
}

class Reader {
    settings = null
    info = null
    highlights = []
    kind = 'reflow' // reflow | fixed | pdf
    barsVisible = false
    tocHrefs = new Map()
    searchAbort = null

    async open() {
        await initWebBridge()
        this.settings = bridge.getSettings()
        this.info = bridge.getBookInfo()
        document.body.dataset.theme = this.settings.theme
        $('#title').textContent = this.info.title || ''
        this.#bindChrome()
        const fmt = (this.info.format || '').toLowerCase()
        this.highlights = await hostStore.list(this.info.id).catch(() => [])
        phase('fetching file')
        if (fmt === 'pdf') await this.#openPdf()
        else await this.#openBook(fmt)
        this.#renderHighlightList()
        this.#startSession()
        phase('ready')
        $('#loading').hidden = true
        bridge.onReady()
        bridge.keepScreenOn(this.settings.keepScreenOn)
        if (!localStorage.getItem('hint-shown')) {
            localStorage.setItem('hint-shown', '1')
            const hint = $('#tap-hint')
            hint.innerHTML = '<div>← back</div><div>tap for menu<br><small>hold a word for its meaning</small></div><div>next →</div>'
            hint.hidden = false
            setTimeout(() => hint.hidden = true, 3200)
        }
    }

    // ---------- reflowable / fixed-layout books via foliate-js ----------
    async #openBook(fmt) {
        const res = await fetch(this.info.url)
        if (!res.ok) throw new Error(`Could not read file (${res.status})`)
        const blob = await res.blob()
        phase(`parsing book (${Math.round(blob.size / 1024)} KB)`)
        const file = new File([blob], this.info.fileName || 'book', { type: blob.type })
        const book = isTextFormat(fmt) ? await makeTextBook(blob, this.info.fileName || 'book.txt', fmt) : file

        const view = document.createElement('foliate-view')
        $('#book').append(view)
        this.view = view
        await view.open(book)
        this.book = view.book
        this.kind = view.isFixedLayout ? 'fixed' : 'reflow'
        document.body.dataset.kind = this.kind

        view.addEventListener('load', e => this.#onSectionLoad(e.detail))
        view.addEventListener('relocate', e => this.#onRelocate(e.detail))
        view.addEventListener('draw-annotation', e => {
            const { draw, annotation } = e.detail
            const saved = this.hlByAnnotation?.get(annotation)
            if (saved) draw(Overlayer.highlight, { color: HL_COLORS[saved.color] || HL_COLORS.lime })
            else if (annotation === this.ttsAnnotation) draw(Overlayer.highlight, { color: 'rgba(91,124,255,0.35)' })
            else if (String(annotation.value).startsWith('foliate-search:')) draw(Overlayer.highlight, { color: 'rgba(255,210,63,0.55)' })
            else draw(Overlayer.highlight, { color: 'rgba(198,242,78,0.75)' })
        })
        view.addEventListener('create-overlay', e => this.#drawSavedHighlights(e.detail.index))
        view.addEventListener('show-annotation', e => {
            const h = this.hlByValue?.get(e.detail.value)
            if (h) this.openHighlightMenu(h)
        })
        view.addEventListener('external-link', e => { e.preventDefault(); bridge.openExternal(e.detail.href) })
        this.book.transformTarget?.addEventListener('data', ({ detail }) => {
            detail.data = Promise.resolve(detail.data).catch(e => { console.error(e); return '' })
        })

        const title = formatTitle(this.book.metadata?.title) || this.info.title || this.info.fileName
        $('#title').textContent = title
        this.lang = (Array.isArray(this.book.metadata?.language) ? this.book.metadata.language[0] : this.book.metadata?.language) || 'en'
        this.#applyRendererSettings()
        this.#buildToc(this.book.toc ?? [])
        phase('rendering first page')
        await view.init({ lastLocation: this.info.location || undefined })
        if (this.info.needsMetadata) this.#sendMetadata(title).catch(console.error)
    }

    async #sendMetadata(title) {
        const author = formatContributor(this.book.metadata?.author)
        let cover = null
        try { const blob = await this.book.getCover?.(); if (blob) cover = await blobToDataURL(blob) } catch (e) { console.warn(e) }
        bridge.onMetadata({ title, author, cover, language: this.book.metadata?.language ?? null })
    }

    #applyRendererSettings() {
        const s = this.settings, r = this.view?.renderer
        if (!r) return
        if (this.kind === 'reflow') {
            r.setAttribute('flow', s.flow)
            r.setAttribute('margin', `${s.margin}px`)
            r.setAttribute('gap', '6%')
            r.setAttribute('max-inline-size', '760px')
            r.setAttribute('max-column-count', '2')
            r.setAttribute('animated', '')
            r.setStyles?.(this.#bookCSS())
        } else {
            r.setAttribute('zoom', 'fit-page')
        }
    }

    #bookCSS() {
        const s = this.settings, t = THEMES[s.theme] ?? THEMES.light
        const font = s.fontFamily === 'publisher' ? '' :
            `body, p, li, blockquote, dd, td, th, h1, h2, h3, h4, h5, h6 { font-family: ${s.fontFamily} !important; }`
        const force = t.force ? `
            body *:not(img):not(svg):not(svg *):not(video):not(code):not(pre):not(mark) { color: ${t.fg} !important; background-color: transparent !important; border-color: ${t.fg}40 !important; }
            img, svg { ${t.dark ? 'filter: brightness(0.88);' : ''} }` : ''
        return `
            @namespace epub "http://www.idpf.org/2007/ops";
            ${s.selectMode ? '' : '@media (pointer: coarse) { html { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; } }'}
            html { color-scheme: ${t.dark ? 'dark' : 'light'}; --theme-bg-color: ${t.bg}; }
            html, body { background: ${t.bg} !important; color: ${t.fg} !important; }
            html { font-size: ${s.fontSize}px !important; }
            body { font-size: 1em !important; }
            p, li, blockquote, dd, td, th { font-size: 1em !important; line-height: ${s.lineHeight} !important;
                text-align: ${s.justify ? 'justify' : 'start'}; -webkit-hyphens: ${s.hyphenate ? 'auto' : 'manual'}; hyphens: ${s.hyphenate ? 'auto' : 'manual'}; widows: 2; orphans: 2; }
            [align="left"] { text-align: left; } [align="right"] { text-align: right; } [align="center"] { text-align: center; }
            a:link { color: ${t.link} !important; }
            pre { white-space: pre-wrap !important; }
            img, svg, video { max-width: 100% !important; height: auto !important; }
            aside[epub|type~="endnote"], aside[epub|type~="footnote"], aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
            ${font}
            ${force}
        `
    }

    #onSectionLoad({ doc }) {
        doc.addEventListener('click', e => this.#onDocClick(e, doc))
        doc.addEventListener('keydown', e => this.#onKey(e))
        doc.addEventListener('selectionchange', () => this.#onSelectionChange(doc))
        this.#installLongPress(doc, (x, y) => {
            const range = wordRangeAt(doc, x, y)
            if (!range) return
            const index = this.view.renderer.getContents().find(c => c.doc === doc)?.index ?? 0
            this.pending = { doc, range, index }
            this.#highlightRange({ cfi: this.view.getCFI(index, range) })
            this.define(range.toString())
        })
        if (this.kind === 'fixed') {
            let start = null
            doc.addEventListener('touchstart', e => { const t = e.touches[0]; start = { x: t.screenX, y: t.screenY, t: Date.now() } }, { passive: true })
            doc.addEventListener('touchend', e => {
                if (!start) return
                const t = e.changedTouches[0], dx = t.screenX - start.x, dy = t.screenY - start.y
                if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - start.t < 600)
                    dx < 0 ? this.view.goRight() : this.view.goLeft()
                start = null
            }, { passive: true })
        }
    }

    #onDocClick(e, doc) {
        if (Date.now() < (this.suppressTapUntil || 0)) return
        if (e.defaultPrevented || e.target.closest?.('a[href], button, input, select, textarea, video, audio, summary')) return
        if (this.dictOpen) { this.closeDictionary(); return }
        const sel = doc.getSelection?.()
        if (sel && !sel.isCollapsed) return
        const frame = doc.defaultView?.frameElement
        let x = e.clientX
        if (frame) {
            const rect = frame.getBoundingClientRect()
            const scale = frame.clientWidth ? rect.width / frame.clientWidth : 1
            x = rect.left + e.clientX * scale
        }
        this.#handleTap(x)
    }

    #handleTap(x) {
        const w = window.innerWidth
        if (this.dictOpen) { this.closeDictionary(); return }
        if (this.barsVisible) { this.showBars(false); return }
        if (x < w * 0.3) this.goPrev()
        else if (x > w * 0.7) this.goNext()
        else this.showBars(true)
    }

    #onKey(e) {
        const k = e.key
        if (k === 'ArrowLeft' || k === 'PageUp') this.goPrev()
        else if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') this.goNext()
        else if (k === 'Escape') { this.closePanels(); this.showBars(false) }
        else return
        e.preventDefault()
    }

    #onRelocate(detail) {
        const { fraction = 0, location, tocItem, pageItem, cfi } = detail
        this.lastFraction = fraction
        this.lastCfi = cfi
        $('#slider').value = fraction
        $('#slider').style.setProperty('--pct', (fraction * 100) + '%')
        const label = tocItem?.label ?? ''
        $('#status-left').textContent = label
        $('#status-right').textContent = pageItem ? `Page ${pageItem.label}` :
            location ? `${percent.format(fraction)} · ${location.current + 1}/${location.total}` : percent.format(fraction)
        this.#highlightToc(tocItem?.href)
        this.#saveProgress({ location: cfi, fraction, label })
        this.#tickPages(fraction)
        if (fraction >= 0.985 && location && location.current >= location.total - 1) this.#celebrate()
    }

    #saveProgress = debounce(p => bridge.saveProgress(p), 400)

    // ---------- PDF ----------
    async #openPdf() {
        const { PdfViewer } = await import('./pdf-viewer.js')
        this.kind = 'pdf'
        document.body.dataset.kind = 'pdf'
        $('#pdf').hidden = false
        $('#book').hidden = true
        this.pdf = new PdfViewer($('#pdf'), $('#pdf-pages'))
        this.#applyPdfTheme()
        phase('parsing PDF')
        await this.pdf.open(this.info.url)
        phase('rendering first page')
        this.pdf.addEventListener('relocate', e => {
            const { page, total, fraction } = e.detail
            this.lastFraction = fraction
            $('#slider').value = fraction
            $('#slider').style.setProperty('--pct', (fraction * 100) + '%')
            $('#status-left').textContent = this.#pdfTocLabel(page) ?? ''
            $('#status-right').textContent = `Page ${page} of ${total}`
            this.#highlightToc(`page:${this.#nearestOutlinePage(page)}`)
            this.#saveProgress({ location: `page:${page}`, fraction, label: `Page ${page} of ${total}` })
            this.#tickPages(fraction)
            if (page >= total && fraction >= 0.98) this.#celebrate()
        })
        this.pdf.addEventListener('zoom', e => { this.settings.pdfZoom = e.detail.zoom; this.#syncSettingsUI(); bridge.saveSettings(this.settings) })
        if (this.settings.pdfZoom && this.settings.pdfZoom !== 1) this.pdf.setZoom(this.settings.pdfZoom)

        const meta = await this.pdf.getMetadata()
        const title = meta.title || this.info.title || this.info.fileName
        $('#title').textContent = title
        this.outline = await this.pdf.getOutline()
        this.#buildToc(this.outline)
        if (this.info.location?.startsWith('page:')) this.pdf.goToPage(+this.info.location.slice(5))
        else this.pdf.goToPage(1)

        // Tap zones (single tap, delayed to leave room for double-tap zoom).
        let tapTimer = null
        this.#installLongPress($('#pdf'), (x, y) => {
            const range = wordRangeAt(document, x, y)
            if (!range) return
            this.pending = { doc: document, range, page: +range.startContainer.parentElement?.closest('.page')?.dataset.page || this.pdf.current }
            this.#highlightRange({ range })
            this.define(range.toString())
        })
        this.pdf.addEventListener('page-rendered', e => { this.#drawSavedPdfHighlights(e.detail.page, e.detail.el); if (this.lastTtsTarget?.page === e.detail.page) this.#ttsHighlight(this.lastTtsTarget) })
        this.lang = 'en'
        $('#pdf').addEventListener('click', e => {
            if (Date.now() < (this.suppressTapUntil || 0)) return
            if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; return }
            const x = e.clientX
            tapTimer = setTimeout(() => { tapTimer = null; this.#handleTap(x) }, 280)
        })
        window.addEventListener('keydown', e => this.#onKey(e))
        document.addEventListener('selectionchange', () => {
            const sel = document.getSelection()
            if (sel?.anchorNode && $('#pdf').contains(sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode)) this.#onSelectionChange(document)
        })

        if (this.info.needsMetadata) {
            let cover = null
            try { cover = await this.pdf.renderCover() } catch (e) { console.warn(e) }
            bridge.onMetadata({ title, author: meta.author || '', cover })
        }
    }

    #applyPdfTheme() {
        const t = this.settings.theme
        document.body.dataset.pdfFilter = t === 'light' ? '' : t
    }

    #pdfTocLabel(page) {
        let best = null
        const walk = items => { for (const it of items) { const p = +(it.href?.slice(5) ?? NaN); if (p && p <= page && (!best || p >= best.p)) best = { p, label: it.label }; if (it.subitems) walk(it.subitems) } }
        walk(this.outline ?? [])
        return best?.label
    }
    #nearestOutlinePage(page) {
        let best = 0
        const walk = items => { for (const it of items) { const p = +(it.href?.slice(5) ?? NaN); if (p && p <= page && p > best) best = p; if (it.subitems) walk(it.subitems) } }
        walk(this.outline ?? [])
        return best
    }

    // ---------- navigation ----------
    goNext() { this.closeDictionary(); this.kind === 'pdf' ? this.pdf.next() : this.view.goRight() }
    goPrev() { this.closeDictionary(); this.kind === 'pdf' ? this.pdf.prev() : this.view.goLeft() }
    goTo(href) { this.kind === 'pdf' ? this.pdf.goTo(href) : this.view.goTo(href).catch(console.error) }
    goToFraction(f) { this.kind === 'pdf' ? this.pdf.goToFraction(f) : this.view.goToFraction(f).catch(console.error) }

    // ---------- press & hold ----------
    #installLongPress(el, onPress) {
        let timer = null, start = null, fired = false
        const cancel = () => { clearTimeout(timer); timer = null }
        el.addEventListener('touchstart', e => {
            if (!this.settings?.defineOnSelect || this.settings?.selectMode || e.touches.length !== 1) return
            const t = e.touches[0]; start = { x: t.clientX, y: t.clientY }; fired = false
            cancel()
            timer = setTimeout(() => { timer = null; fired = true; onPress(start.x, start.y) }, 420)
        }, { passive: true })
        el.addEventListener('touchmove', e => {
            if (!timer) return
            const t = e.touches[0]
            if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel()
        }, { passive: true })
        el.addEventListener('touchend', e => {
            cancel()
            if (fired) { fired = false; this.suppressTapUntil = Date.now() + 600; if (e.cancelable) e.preventDefault() }
        }, { passive: false })
        el.addEventListener('touchcancel', cancel)
    }

    #highlightRange({ cfi, range }) {
        this.#clearHighlight()
        if (cfi && this.view) {
            this.highlight = { value: cfi }
            this.view.addAnnotation(this.highlight).catch?.(() => {})
        } else if (range) {
            const page = range.startContainer.parentElement?.closest('.page')
            if (!page) return
            const pr = page.getBoundingClientRect()
            this.pdfHighlights = []
            for (const r of range.getClientRects()) {
                const d = document.createElement('div')
                d.className = 'pdf-hl'
                d.style.cssText = `left:${r.left - pr.left - 2}px;top:${r.top - pr.top - 1}px;width:${r.width + 4}px;height:${r.height + 2}px`
                page.append(d); this.pdfHighlights.push(d)
            }
        }
    }
    #clearHighlight() {
        if (this.highlight) { try { this.view?.deleteAnnotation(this.highlight) } catch { /* ignore */ } this.highlight = null }
        this.pdfHighlights?.forEach(d => d.remove()); this.pdfHighlights = null
    }

    // ---------- dictionary ----------
    #selectionTimer = null
    #onSelectionChange(doc) {
        clearTimeout(this.#selectionTimer)
        this.#selectionTimer = setTimeout(() => {
            const sel = doc.getSelection?.()
            if (!sel || sel.isCollapsed || !sel.toString().trim()) { $('#sel-bar').hidden = true; return }
            const range = sel.getRangeAt(0)
            if (this.settings.selectMode) {
                const index = this.view?.renderer.getContents().find(c => c.doc === doc)?.index
                const page = this.kind === 'pdf' ? +(range.startContainer.parentElement?.closest('.page')?.dataset.page || this.pdf.current) : undefined
                this.pending = { doc, range: range.cloneRange(), index, page }
                $('#sel-bar').hidden = false
                return
            }
            if (!this.settings.defineOnSelect || COARSE) return
            const phrase = selectedPhrase(sel)
            if (!phrase) return
            if (this.dictOpen && normalizeWord(phrase).toLowerCase() === (this.dictWord || '').toLowerCase()) return
            const index = this.view?.renderer.getContents().find(c => c.doc === doc)?.index
            this.pending = { doc, range: range.cloneRange(), index, page: this.kind === 'pdf' ? this.pdf.current : undefined }
            this.define(phrase)
        }, 450)
    }

    // Host-coordinate vertical centre of the pending range (iframe ranges are offset by their frame).
    #pendingY() {
        const p = this.pending
        if (!p?.range) return null
        const r = p.range.getBoundingClientRect()
        const frame = p.doc?.defaultView?.frameElement
        if (!frame) return r.top + r.height / 2
        const fr = frame.getBoundingClientRect()
        const scale = frame.clientHeight ? fr.height / frame.clientHeight : 1
        return fr.top + (r.top + r.height / 2) * scale
    }
    async define(phrase) {
        const word = normalizeWord(phrase)
        if (!word) return
        // Open the card away from the word: from the top when the word sits in the lower half.
        const y = this.#pendingY()
        $('#dict-card').classList.toggle('top', y != null && y > window.innerHeight * 0.5)
        this.dictWord = word
        this.dictPhrase = phrase.replace(/\s+/g, ' ').trim()
        this.dictOpen = true
        this.#dictTab('meaning')
        $('#tr-body').innerHTML = ''
        const card = $('#dict-card')
        card.classList.remove('hidden')
        $('#dict-word').textContent = word
        $('#dict-phon').textContent = ''
        $('#dict-source').textContent = ''
        $('#dict-speak').hidden = true
        $('#dict-more').hidden = true
        const body = $('#dict-body')
        body.innerHTML = '<div class="dict-loading"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>'
        let result = null, error = null
        try { result = await lookup(word) } catch (e) { error = e }
        if (this.dictWord !== word) return // superseded
        if (result) this.#renderDefinition(result)
        else {
            const wikt = `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`
            body.innerHTML = error
                ? `<p class="dict-empty">${error.message === 'offline' || !navigator.onLine ? 'You’re offline. Definitions need a connection the first time you look a word up; after that they’re saved on this device.' : 'Couldn’t reach the dictionary right now.'}</p>`
                : `<p class="dict-empty">No entry for “${escapeHTML(word)}”. Try the root word, or search the web.</p>`
            $('#dict-more').hidden = false
            $('#dict-more').onclick = () => bridge.openExternal(wikt)
        }
    }

    #renderDefinition(r) {
        $('#dict-word').textContent = r.word
        $('#dict-phon').textContent = [r.phonetic, r.inflection].filter(Boolean).join(' · ')
        $('#dict-source').textContent = r.source
        const speakBtn = $('#dict-speak')
        speakBtn.hidden = !(r.audio || 'speechSynthesis' in window)
        speakBtn.onclick = () => { speakBtn.classList.add('playing'); Promise.resolve(speak(r.word, r.audio)).finally(() => setTimeout(() => speakBtn.classList.remove('playing'), 900)) }
        const more = $('#dict-more'); more.hidden = false; more.onclick = () => bridge.openExternal(r.url)
        const body = $('#dict-body')
        body.innerHTML = r.meanings.map(m => `
            <section class="dict-meaning">
                <span class="dict-pos">${escapeHTML(m.pos || '')}</span>
                <ol class="dict-defs">${m.defs.map(d => `<li>${escapeHTML(d.def)}${d.example ? `<em class="dict-ex">“${escapeHTML(d.example)}”</em>` : ''}</li>`).join('')}</ol>
                ${m.synonyms?.length ? `<p class="dict-syn">${m.synonyms.map(x => `<button class="dict-chip" data-word="${escapeHTML(x)}">${escapeHTML(x)}</button>`).join('')}</p>` : ''}
            </section>`).join('')
        body.querySelectorAll('.dict-chip').forEach(b => b.addEventListener('click', () => this.define(b.dataset.word)))
        body.scrollTop = 0
    }

    closeDictionary() {
        if (!this.dictOpen) return
        this.dictOpen = false
        this.dictWord = null
        $('#dict-card').classList.add('hidden')
        $('#sel-bar').hidden = true
        this.#clearHighlight()
        try { this.view?.deselect?.(); document.getSelection()?.removeAllRanges() } catch { /* ignore */ }
    }

    // ---------- dictionary tabs / translate ----------
    #dictTab(name) {
        $$('[data-dtab]').forEach(t => t.classList.toggle('active', t.dataset.dtab === name))
        $('#dict-body').hidden = name !== 'meaning'
        $('#tr-body').hidden = name !== 'translate'
        if (name === 'translate') this.#translateCurrent()
    }
    async #translateCurrent() {
        const text = this.pending?.range?.toString()?.trim() || this.dictPhrase || this.dictWord
        const target = this.settings.translateTo || defaultTarget()
        const body = $('#tr-body')
        const label = LANGS.find(([c]) => c === target)?.[1] || target
        body.innerHTML = `<div class="dict-loading"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`
        try {
            const r = await translate(text, target, this.lang || 'en')
            if ($('#tr-body').hidden) return
            body.innerHTML = `<p class="tr-src">${escapeHTML(text)}</p><p class="tr-out">${escapeHTML(r.text)}</p><p class="dict-src">→ ${escapeHTML(label)} · ${escapeHTML(r.source)}</p>`
        } catch (e) {
            body.innerHTML = `<p class="dict-empty">${navigator.onLine ? 'Couldn’t translate right now.' : 'You’re offline. Translations need a connection.'}</p>`
            console.warn(e)
        }
    }

    // ---------- highlights & notes ----------
    #expandPendingToSentence() {
        const p = this.pending
        if (!p?.range) return
        const r = p.range
        const node = r.startContainer, end = r.endContainer
        if (node.nodeType !== 3) return
        const text = node.data
        let st = r.startOffset, en = end === node ? r.endOffset : text.length
        while (st > 0 && !/[.!?]/.test(text[st - 1])) st--
        while (st < text.length && /\s/.test(text[st])) st++
        while (en < text.length && !/[.!?]/.test(text[en])) en++
        if (en < text.length) en++
        const range = p.doc.createRange(); range.setStart(node, st); range.setEnd(node, en)
        p.range = range
        if (p.index != null) this.#highlightRange({ cfi: this.view.getCFI(p.index, range) }); else this.#highlightRange({ range })
        this.dictPhrase = range.toString().trim()
        this.toast('whole sentence selected')
    }
    async saveHighlight(color, note = '') {
        const p = this.pending
        if (!p?.range) return
        const text = p.range.toString().replace(/\s+/g, ' ').trim()
        const h = { color, note, text }
        if (this.kind === 'pdf') {
            const pageEl = p.range.startContainer.parentElement?.closest('.page'); if (!pageEl) return
            const pr = pageEl.getBoundingClientRect()
            h.kind = 'pdf'; h.page = +pageEl.dataset.page
            h.rects = Array.from(p.range.getClientRects()).map(r => ({ x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height, w: r.width / pr.width, h: r.height / pr.height }))
        } else {
            h.kind = 'epub'; h.cfi = this.view.getCFI(p.index ?? 0, p.range)
        }
        await hostStore.save(this.info.id, h)
        this.highlights.push(h)
        this.closeDictionary()
        this.#drawSaved(h)
        this.#renderHighlightList()
        this.toast(note ? 'note saved' : 'highlighted')
        return h
    }
    #drawSaved(h) {
        if (h.kind === 'pdf') {
            const el = $(`#pdf .page[data-page="${h.page}"]`)
            if (el && el.querySelector('canvas')) this.#drawSavedPdfHighlights(h.page, el)
            return
        }
        this.hlByAnnotation ??= new Map(); this.hlByValue ??= new Map()
        const ann = { value: h.cfi }
        this.hlByAnnotation.set(ann, h); this.hlByValue.set(h.cfi, h); h._ann = ann
        this.view.addAnnotation(ann).catch?.(() => {})
    }
    #drawSavedHighlights(index) {
        for (const h of this.highlights) {
            if (h.kind !== 'epub') continue
            try { if (this.view.resolveCFI(h.cfi).index !== index) continue } catch { continue }
            if (!h._ann) this.#drawSaved(h); else this.view.addAnnotation(h._ann).catch?.(() => {})
        }
    }
    #drawSavedPdfHighlights(page, el) {
        el.querySelectorAll('.pdf-hl.saved').forEach(d => d.remove())
        for (const h of this.highlights) {
            if (h.kind !== 'pdf' || h.page !== page) continue
            for (const r of h.rects || []) {
                const d = document.createElement('div')
                d.className = `pdf-hl saved ${h.color || 'lime'}`
                d.style.cssText = `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`
                d.addEventListener('click', e => { e.stopPropagation(); this.openHighlightMenu(h) })
                el.append(d)
            }
        }
    }
    #removeDrawn(h) {
        if (h.kind === 'pdf') { const el = $(`#pdf .page[data-page="${h.page}"]`); if (el) this.#drawSavedPdfHighlights(h.page, el); return }
        if (h._ann) { try { this.view.deleteAnnotation(h._ann) } catch { /* ignore */ } this.hlByAnnotation?.delete(h._ann); this.hlByValue?.delete(h.cfi) }
    }
    openHighlightMenu(h) {
        this.hlmTarget = h
        this.hlmColor = h?.color || 'sun'
        $('#hlm-text').textContent = h?.text || this.pending?.range?.toString().trim() || this.dictPhrase || ''
        $('#hlm-note').value = h?.note || ''
        $$('#hl-menu .dot').forEach(x => x.classList.toggle('active', x.dataset.hlm === this.hlmColor))
        $('#hlm-delete').hidden = !h
        if (!h) $('#dict-card').classList.add('hidden')
        this.openPanel('hl-menu')
        setTimeout(() => $('#hlm-note').focus(), 300)
    }
    async #saveHighlightMenu() {
        const note = $('#hlm-note').value.trim()
        const h = this.hlmTarget
        if (h) {
            const colorChanged = h.color !== this.hlmColor
            h.note = note; h.color = this.hlmColor
            await hostStore.save(this.info.id, h)
            if (colorChanged) { this.#removeDrawn(h); delete h._ann; this.#drawSaved(h) }
            this.#renderHighlightList(); this.closePanels(); this.toast('saved')
        } else {
            this.closePanels()
            await this.saveHighlight(this.hlmColor, note)
        }
    }
    async #deleteHighlightMenu() {
        const h = this.hlmTarget; if (!h) return
        await hostStore.remove(this.info.id, h.id)
        this.highlights = this.highlights.filter(x => x.id !== h.id)
        this.#removeDrawn(h)
        this.#renderHighlightList(); this.closePanels(); this.toast('deleted')
    }
    #renderHighlightList() {
        const list = $('#hl-list'); list.textContent = ''
        const items = [...(this.highlights || [])].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        if (!items.length) { const d = document.createElement('div'); d.className = 'search-status'; d.textContent = 'hold a word, then tap a colour to highlight it.'; list.append(d); return }
        for (const h of items) {
            const b = document.createElement('button'); b.className = 'hl-item'; b.style.setProperty('--c', HL_COLORS[h.color] || HL_COLORS.lime)
            b.innerHTML = `<span class="q">${escapeHTML(h.text)}</span>${h.note ? `<span class="n">${escapeHTML(h.note)}</span>` : ''}<span class="d">${h.kind === 'pdf' ? `page ${h.page}` : ''} ${new Date(h.createdAt || Date.now()).toLocaleDateString()}</span>`
            b.addEventListener('click', () => { this.closePanels(); this.showBars(false); if (h.kind === 'pdf') this.pdf.goToPage(h.page); else this.view.goTo(h.cfi).catch(console.error) })
            b.addEventListener('contextmenu', e => { e.preventDefault(); this.openHighlightMenu(h) })
            list.append(b)
        }
    }
    #selAction(action) {
        const p = this.pending; if (!p?.range) return
        const text = p.range.toString().trim()
        if (action === 'copy') return this.#copy(text)
        if (action === 'highlight') return this.saveHighlight('lime')
        this.define(text.split(/\s+/).length > 4 ? text.split(/\s+/).slice(0, 4).join(' ') : text)
        if (action === 'translate') { this.dictPhrase = text; this.#dictTab('translate') }
    }
    #copy(text) {
        if (!text) return
        navigator.clipboard?.writeText(text).then(() => this.toast('copied'), () => this.toast('couldn’t copy'))
    }

    // ---------- listen ----------
    async toggleListen() {
        if (this.listener && this.listener.state !== 'idle') { this.listener.toggle(); return }
        this.listener ??= new Listener({
            view: this.kind === 'pdf' ? null : this.view, pdf: this.kind === 'pdf' ? this.pdf : null, lang: this.lang || 'en',
            onHighlight: target => this.#ttsHighlight(target),
        })
        if (!this.listener.supported) { this.toast('no voices on this device'); return }
        this.listener.addEventListener('state', e => {
            const st = e.detail
            $('#listen-bar').hidden = st === 'idle'
            $('#listen-bar').classList.toggle('playing', st === 'playing')
            $('#btn-listen').classList.toggle('on', st !== 'idle')
            if (st === 'idle') this.#ttsHighlight(null)
        })
        this.listener.addEventListener('done', () => this.toast('end of book'))
        $$('.ls-rates button').forEach(x => x.classList.toggle('active', +x.dataset.rate === this.listener.rate))
        this.showBars(false)
        try { await this.listener.start() } catch (e) { this.toast(e.message) }
    }
    stopListen() { this.listener?.stop() }
    #ttsHighlight(target) {
        this.lastTtsTarget = target
        if (this.kind === 'pdf') {
            $$('.textLayer span.tts-on').forEach(s => s.classList.remove('tts-on'))
            if (!target) return
            const layer = $(`#pdf .page[data-page="${target.page}"] .textLayer`); if (!layer) return
            const spans = layer.querySelectorAll('span')
            target.spanIndices.forEach(i => spans[i]?.classList.add('tts-on'))
            spans[target.spanIndices[0]]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            return
        }
        if (this.ttsAnnotation) { try { this.view.deleteAnnotation(this.ttsAnnotation) } catch { /* ignore */ } this.ttsAnnotation = null }
        if (!target) return
        const index = this.view.renderer.getContents()[0]?.index ?? 0
        this.ttsAnnotation = { value: this.view.getCFI(index, target) }
        this.view.addAnnotation(this.ttsAnnotation).catch?.(() => {})
        this.view.renderer.scrollToAnchor?.(target, true)
    }

    // ---------- reading sessions & finishing ----------
    #startSession() {
        if (this.session) return
        this.session = { id: uuid(), startedAt: Date.now(), seconds: 0, pages: 0, fractionStart: this.lastFraction ?? 0 }
        this.sessionTimer = setInterval(() => {
            if (document.hidden) return
            this.session.seconds += 15
            if (this.session.seconds % 60 === 0) this.#flushSession()
        }, 15000)
    }
    #tickPages(fraction) {
        if (!this.session) return
        if (this.session.lastFraction != null && Math.abs(fraction - this.session.lastFraction) > 0.0005) this.session.pages++
        this.session.lastFraction = fraction
    }
    #flushSession() {
        if (!this.session || this.session.seconds < 15) return
        const s = { ...this.session, endedAt: Date.now(), fractionEnd: this.lastFraction ?? this.session.fractionStart }
        delete s.lastFraction
        hostStore.saveSession(this.info.id, s)
    }
    #endSession() {
        if (!this.session) return
        clearInterval(this.sessionTimer)
        this.#flushSession()
        this.session = null
    }
    #celebrate() {
        const key = 'dogear.finished.' + this.info.id
        if (localStorage.getItem(key)) return
        localStorage.setItem(key, '1')
        hostStore.markFinished()
        $('#finish-title').textContent = $('#title').textContent
        $('#finish').hidden = false
        this.#confetti()
    }
    #confetti() {
        const c = $('#confetti'); const ctx = c.getContext('2d')
        c.width = c.clientWidth; c.height = c.clientHeight
        const colors = ['#c6f24e', '#ff5ca8', '#5b7cff', '#ffd23f', '#ff8a3d', '#b388ff']
        const parts = Array.from({ length: 140 }, () => ({ x: Math.random() * c.width, y: -20 - Math.random() * c.height * 0.5, vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3, r: 4 + Math.random() * 5, a: Math.random() * 6.28, va: (Math.random() - 0.5) * 0.3, col: colors[Math.floor(Math.random() * colors.length)] }))
        const t0 = performance.now()
        const frame = now => {
            ctx.clearRect(0, 0, c.width, c.height)
            for (const p of parts) { p.x += p.vx; p.y += p.vy; p.a += p.va; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.col; ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6); ctx.restore() }
            if (now - t0 < 4000 && !$('#finish').hidden) requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
    }

    toast(msg, ms = 1800) {
        const t = $('#toast'); t.textContent = msg; t.hidden = false
        clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => t.hidden = true, ms)
    }

    // ---------- chrome ----------
    showBars(v) {
        this.barsVisible = v
        $('#top-bar').classList.toggle('hidden', !v)
        $('#bottom-bar').classList.toggle('hidden', !v)
        bridge.setBarsVisible(v)
    }
    openPanel(id) {
        this.closePanels()
        $('#' + id).classList.remove('hidden')
        $('#scrim').classList.remove('hidden')
        if (id === 'search-panel') setTimeout(() => $('#search-input').focus(), 250)
    }
    closePanels() {
        let closed = false
        for (const p of $$('.panel:not(.dict)')) if (!p.classList.contains('hidden')) { p.classList.add('hidden'); closed = true }
        $('#scrim').classList.add('hidden')
        return closed
    }
    onBack() {
        if (this.dictOpen) { this.closeDictionary(); return true }
        if (this.closePanels()) return true
        if (this.barsVisible) { this.showBars(false); return true }
        return false
    }

    #bindChrome() {
        $('#btn-back').addEventListener('click', () => bridge.close())
        $('#error-back').addEventListener('click', () => bridge.close())
        $('#btn-toc').addEventListener('click', () => this.openPanel('toc-panel'))
        $('#btn-search').addEventListener('click', () => this.openPanel('search-panel'))
        $('#btn-settings').addEventListener('click', () => { this.#syncSettingsUI(); this.openPanel('settings-panel') })
        $('#scrim').addEventListener('click', () => this.closePanels())
        $$('[data-close]').forEach(b => b.addEventListener('click', () => this.closePanels()))
        $('#btn-prev-ch').addEventListener('click', () => this.goPrev())
        $('#btn-next-ch').addEventListener('click', () => this.goNext())
        const slider = $('#slider')
        slider.addEventListener('input', () => { $('#status-right').textContent = percent.format(+slider.value); slider.style.setProperty('--pct', (+slider.value * 100) + '%') })
        slider.addEventListener('change', () => this.goToFraction(+slider.value))
        $('#book').addEventListener('click', e => { if (e.target === $('#book') || e.target.tagName === 'FOLIATE-VIEW') this.#handleTap(e.clientX) })
        window.addEventListener('keydown', e => { if (this.kind !== 'pdf') this.#onKey(e) })

        // settings
        $$('#theme-chips [data-theme]').forEach(c => c.addEventListener('click', () => this.#update({ theme: c.dataset.theme })))
        $$('[data-flow]').forEach(c => c.addEventListener('click', () => this.#update({ flow: c.dataset.flow })))
        $$('[data-step]').forEach(b => b.addEventListener('click', () => {
            const k = b.dataset.step, d = +b.dataset.delta
            const limits = { fontSize: [10, 40], lineHeight: [1, 2.6], margin: [0, 72], pdfZoom: [0.5, 5] }[k]
            const v = Math.min(limits[1], Math.max(limits[0], +(this.settings[k] + d).toFixed(2)))
            this.#update({ [k]: v })
        }))
        $('#sel-font').addEventListener('change', e => this.#update({ fontFamily: e.target.value }))
        $('#chk-justify').addEventListener('change', e => this.#update({ justify: e.target.checked }))
        $('#chk-wake').addEventListener('change', e => this.#update({ keepScreenOn: e.target.checked }))
        $('#chk-define').addEventListener('change', e => this.#update({ defineOnSelect: e.target.checked }))
        $('#chk-select').addEventListener('change', e => this.#update({ selectMode: e.target.checked }))
        const langSel = $('#sel-lang')
        langSel.innerHTML = LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('')
        langSel.addEventListener('change', e => this.#update({ translateTo: e.target.value }))
        $$('.chip.preset').forEach(c => c.addEventListener('click', () => { this.#update({ ...PRESETS[c.dataset.preset] }); this.toast(`${c.textContent.trim()} preset`) }))
        $('#dict-close').addEventListener('click', () => this.closeDictionary())
        $$('[data-dtab]').forEach(t => t.addEventListener('click', () => this.#dictTab(t.dataset.dtab)))
        $$('#dict-card [data-hl]').forEach(d => d.addEventListener('click', () => this.saveHighlight(d.dataset.hl)))
        $('#act-sentence').addEventListener('click', () => this.#expandPendingToSentence())
        $('#act-note').addEventListener('click', () => this.openHighlightMenu(null))
        $('#act-copy').addEventListener('click', () => this.#copy(this.pending?.range?.toString() || this.dictPhrase))
        $$('#sel-bar [data-sel]').forEach(b => b.addEventListener('click', () => this.#selAction(b.dataset.sel)))
        $$('#toc-tabs .tab').forEach(t => t.addEventListener('click', () => {
            $$('#toc-tabs .tab').forEach(x => x.classList.toggle('active', x === t))
            $('#toc-list').hidden = t.dataset.tab !== 'toc-list'; $('#hl-list').hidden = t.dataset.tab !== 'hl-list'
        }))
        $$('#hl-menu [data-hlm]').forEach(d => d.addEventListener('click', () => { this.hlmColor = d.dataset.hlm; $$('#hl-menu .dot').forEach(x => x.classList.toggle('active', x === d)) }))
        $('#hlm-save').addEventListener('click', () => this.#saveHighlightMenu())
        $('#hlm-delete').addEventListener('click', () => this.#deleteHighlightMenu())
        $('#hlm-define').addEventListener('click', () => { const t = this.hlmTarget?.text || $('#hlm-text').textContent; this.closePanels(); this.define(t.split(/\s+/).slice(0, 4).join(' ')) })
        // listen
        $('#btn-listen').addEventListener('click', () => this.toggleListen())
        $('#ls-toggle').addEventListener('click', () => this.listener?.toggle())
        $('#ls-prev').addEventListener('click', () => this.listener?.prev())
        $('#ls-next').addEventListener('click', () => this.listener?.next())
        $('#ls-close').addEventListener('click', () => this.stopListen())
        $$('.ls-rates button').forEach(b => b.addEventListener('click', () => { this.listener?.setRate(+b.dataset.rate); $$('.ls-rates button').forEach(x => x.classList.toggle('active', x === b)) }))
        $('#finish-shelf').addEventListener('click', () => bridge.close())
        $('#finish-stay').addEventListener('click', () => { $('#finish').hidden = true })
        // the body must never scroll: hidden sheets hang below it and a focus-scroll would shift the whole UI
        const unscroll = () => { if (document.body.scrollTop || document.body.scrollLeft) { document.body.scrollTop = 0; document.body.scrollLeft = 0 } }
        document.body.addEventListener('scroll', unscroll); window.addEventListener('focusin', () => setTimeout(unscroll, 50))
        window.addEventListener('pagehide', () => this.#endSession())
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.#endSession(); else this.#startSession() })

        // search
        const input = $('#search-input')
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.#search(input.value.trim()) } })
        input.addEventListener('search', () => { if (!input.value) this.#clearSearch() })
    }

    #update(patch) {
        Object.assign(this.settings, patch)
        bridge.saveSettings(this.settings)
        document.body.dataset.theme = this.settings.theme
        if (this.kind === 'pdf') {
            this.#applyPdfTheme()
            if ('pdfZoom' in patch) this.pdf.setZoom(this.settings.pdfZoom)
        } else this.#applyRendererSettings()
        if ('keepScreenOn' in patch) bridge.keepScreenOn(this.settings.keepScreenOn)
        this.#syncSettingsUI()
    }

    #syncSettingsUI() {
        const s = this.settings
        $$('#theme-chips [data-theme]').forEach(c => c.classList.toggle('active', c.dataset.theme === s.theme))
        $$('[data-flow]').forEach(c => c.classList.toggle('active', c.dataset.flow === s.flow))
        $('#val-fontSize').textContent = s.fontSize
        $('#val-lineHeight').textContent = s.lineHeight.toFixed(1)
        $('#val-margin').textContent = s.margin
        $('#val-pdfZoom').textContent = Math.round(s.pdfZoom * 100) + '%'
        $('#sel-font').value = s.fontFamily
        $('#chk-justify').checked = !!s.justify
        $('#chk-wake').checked = !!s.keepScreenOn
        $('#chk-define').checked = s.defineOnSelect !== false
        $('#chk-select').checked = !!s.selectMode
        $('#sel-lang').value = s.translateTo || defaultTarget()
    }

    #buildToc(items) {
        const list = $('#toc-list')
        list.textContent = ''
        this.tocHrefs.clear()
        const add = (arr, depth) => {
            for (const it of arr ?? []) {
                const b = document.createElement('button')
                b.className = 'toc-item'
                b.dataset.depth = Math.min(depth, 3)
                b.textContent = it.label?.trim() || '—'
                if (it.href) {
                    b.dataset.href = it.href
                    this.tocHrefs.set(it.href, b)
                    b.addEventListener('click', () => { this.goTo(it.href); this.closePanels(); this.showBars(false) })
                } else b.disabled = true
                list.append(b)
                add(it.subitems, depth + 1)
            }
        }
        add(items, 0)
        if (!list.children.length) {
            const d = document.createElement('div'); d.className = 'search-status'; d.textContent = 'No table of contents.'; list.append(d)
        }
    }
    #highlightToc(href) {
        if (this.currentTocEl) this.currentTocEl.classList.remove('current')
        const el = href != null ? this.tocHrefs.get(href) : null
        if (el) { el.classList.add('current'); this.currentTocEl = el } else this.currentTocEl = null
    }

    async #search(query) {
        this.#clearSearch()
        if (!query) return
        const results = $('#search-results')
        const status = document.createElement('div'); status.className = 'search-status'; status.textContent = 'Searching…'
        results.append(status)
        const ac = new AbortController(); this.searchAbort = ac
        const addHit = (group, excerpt, onClick) => {
            if (group != null && group !== addHit.lastGroup) {
                const g = document.createElement('div'); g.className = 'search-group'; g.textContent = group || 'Results'; results.insertBefore(g, status)
                addHit.lastGroup = group
            }
            const b = document.createElement('button'); b.className = 'search-hit'
            b.append(excerpt.pre, Object.assign(document.createElement('mark'), { textContent: excerpt.match }), excerpt.post)
            b.addEventListener('click', () => { onClick(); this.closePanels(); this.showBars(false) })
            results.insertBefore(b, status)
            addHit.count = (addHit.count ?? 0) + 1
        }
        addHit.lastGroup = undefined; addHit.count = 0
        try {
            if (this.kind === 'pdf') {
                this.pdf.addEventListener('search-progress', e => { status.textContent = `Searching page ${e.detail.page} of ${e.detail.total}…` }, { signal: ac.signal })
                const list = await this.pdf.search(query, ac.signal)
                for (const r of list) addHit(`Page ${r.page}`, { pre: r.before, match: r.match, post: r.after }, () => this.pdf.goToPage(r.page))
            } else {
                for await (const r of this.view.search({ query, matchCase: false, matchDiacritics: false, matchWholeWords: false })) {
                    if (ac.signal.aborted) break
                    if (r === 'done') break
                    if (r.progress != null) status.textContent = `Searching… ${percent.format(r.progress)}`
                    if (r.subitems) for (const { cfi, excerpt } of r.subitems)
                        addHit(r.label, excerpt, () => this.view.goTo(cfi))
                }
            }
            status.textContent = addHit.count ? `${addHit.count} result${addHit.count === 1 ? '' : 's'}` : 'No results.'
        } catch (e) { console.error(e); status.textContent = 'Search failed.' }
    }
    #clearSearch() {
        this.searchAbort?.abort()
        $('#search-results').textContent = ''
        this.view?.clearSearch?.()
    }
}

const reader = new Reader()
globalThis.reader = reader
globalThis.onAndroidBack = () => reader.onBack()
reader.open().catch(e => {
    console.error(e)
    $('#loading').hidden = true
    $('#error').hidden = false
    $('#error-text').textContent = e?.message || String(e)
    bridge.onError(e?.message || String(e))
})
