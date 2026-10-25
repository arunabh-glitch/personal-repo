import './foliate/view.js'
import { makeTextBook, isTextFormat } from './text-book.js'
import { createWebBridge } from './web-bridge.js'

const $ = s => document.querySelector(s)
const $$ = s => Array.from(document.querySelectorAll(s))

const DEFAULTS = {
    theme: 'light', fontSize: 18, lineHeight: 1.5, margin: 24, fontFamily: 'publisher',
    flow: 'paginated', justify: true, hyphenate: true, pdfZoom: 1, keepScreenOn: false,
}
const THEMES = {
    light: { bg: '#ffffff', fg: '#1b1b1b', link: '#1a5fb4', dark: false, force: false },
    sepia: { bg: '#f4ecd8', fg: '#5b4636', link: '#8b4513', dark: false, force: true },
    gray:  { bg: '#2b2b2b', fg: '#d6d6d6', link: '#8ab4f8', dark: true, force: true },
    dark:  { bg: '#000000', fg: '#c8c8c8', link: '#8ab4f8', dark: true, force: true },
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
const phase = p => { globalThis.__phase = p; console.log('phase: ' + p) }
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
        phase('fetching file')
        if (fmt === 'pdf') await this.#openPdf()
        else await this.#openBook(fmt)
        phase('ready')
        $('#loading').hidden = true
        bridge.onReady()
        bridge.keepScreenOn(this.settings.keepScreenOn)
        if (!localStorage.getItem('hint-shown')) {
            localStorage.setItem('hint-shown', '1')
            const hint = $('#tap-hint')
            hint.innerHTML = '<div>◀ previous</div><div>menu</div><div>next ▶</div>'
            hint.hidden = false
            setTimeout(() => hint.hidden = true, 2200)
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
        view.addEventListener('external-link', e => { e.preventDefault(); bridge.openExternal(e.detail.href) })
        this.book.transformTarget?.addEventListener('data', ({ detail }) => {
            detail.data = Promise.resolve(detail.data).catch(e => { console.error(e); return '' })
        })

        const title = formatTitle(this.book.metadata?.title) || this.info.title || this.info.fileName
        $('#title').textContent = title
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
            html { color-scheme: ${t.dark ? 'dark' : 'light'}; }
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
        if (e.defaultPrevented || e.target.closest?.('a[href], button, input, select, textarea, video, audio, summary')) return
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
        const label = tocItem?.label ?? ''
        $('#status-left').textContent = label
        $('#status-right').textContent = pageItem ? `Page ${pageItem.label}` :
            location ? `${percent.format(fraction)} · ${location.current + 1}/${location.total}` : percent.format(fraction)
        this.#highlightToc(tocItem?.href)
        this.#saveProgress({ location: cfi, fraction, label })
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
            $('#status-left').textContent = this.#pdfTocLabel(page) ?? ''
            $('#status-right').textContent = `Page ${page} of ${total}`
            this.#highlightToc(`page:${this.#nearestOutlinePage(page)}`)
            this.#saveProgress({ location: `page:${page}`, fraction, label: `Page ${page} of ${total}` })
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
        $('#pdf').addEventListener('click', e => {
            if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; return }
            const x = e.clientX
            tapTimer = setTimeout(() => { tapTimer = null; this.#handleTap(x) }, 280)
        })
        window.addEventListener('keydown', e => this.#onKey(e))

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
    goNext() { this.kind === 'pdf' ? this.pdf.next() : this.view.goRight() }
    goPrev() { this.kind === 'pdf' ? this.pdf.prev() : this.view.goLeft() }
    goTo(href) { this.kind === 'pdf' ? this.pdf.goTo(href) : this.view.goTo(href).catch(console.error) }
    goToFraction(f) { this.kind === 'pdf' ? this.pdf.goToFraction(f) : this.view.goToFraction(f).catch(console.error) }

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
        for (const p of $$('.panel')) if (!p.classList.contains('hidden')) { p.classList.add('hidden'); closed = true }
        $('#scrim').classList.add('hidden')
        return closed
    }
    onBack() {
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
        slider.addEventListener('input', () => { $('#status-right').textContent = percent.format(+slider.value) })
        slider.addEventListener('change', () => this.goToFraction(+slider.value))
        $('#book').addEventListener('click', e => { if (e.target === $('#book') || e.target.tagName === 'FOLIATE-VIEW') this.#handleTap(e.clientX) })
        window.addEventListener('keydown', e => { if (this.kind !== 'pdf') this.#onKey(e) })

        // settings
        $$('#theme-chips .chip').forEach(c => c.addEventListener('click', () => this.#update({ theme: c.dataset.theme })))
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
        $$('#theme-chips .chip').forEach(c => c.classList.toggle('active', c.dataset.theme === s.theme))
        $$('[data-flow]').forEach(c => c.classList.toggle('active', c.dataset.flow === s.flow))
        $('#val-fontSize').textContent = s.fontSize
        $('#val-lineHeight').textContent = s.lineHeight.toFixed(1)
        $('#val-margin').textContent = s.margin
        $('#val-pdfZoom').textContent = Math.round(s.pdfZoom * 100) + '%'
        $('#sel-font').value = s.fontFamily
        $('#chk-justify').checked = !!s.justify
        $('#chk-wake').checked = !!s.keepScreenOn
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
