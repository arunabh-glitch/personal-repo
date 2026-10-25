// Continuous-scroll PDF viewer built on pdf.js with lazy page rendering,
// pinch/double-tap zoom, outline, text search and progress events.
import * as pdfjsLib from './pdfjs/pdf.min.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.js', import.meta.url).href
const CMAP_URL = new URL('./pdfjs/cmaps/', import.meta.url).href
const FONT_URL = new URL('./pdfjs/standard_fonts/', import.meta.url).href
const MAX_CANVAS_PIXELS = 12_000_000

export class PdfViewer extends EventTarget {
    constructor(container, pagesEl) {
        super()
        this.container = container
        this.pagesEl = pagesEl
        this.zoom = 1
        this.pages = [] // { el, canvas, w, h, task, rendered, scaleRendered }
        this.current = 1
        this.#bindGestures()
        this.container.addEventListener('scroll', () => this.#onScroll(), { passive: true })
        this.ro = new ResizeObserver(() => this.#relayout(true))
        this.ro.observe(this.container)
    }

    async open(url) {
        const task = pdfjsLib.getDocument({
            url, cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: FONT_URL,
            isEvalSupported: false,
        })
        this.pdf = await task.promise
        this.total = this.pdf.numPages
        const first = await this.pdf.getPage(1)
        const vp = first.getViewport({ scale: 1 })
        this.defaultSize = { w: vp.width, h: vp.height }
        this.pagesEl.textContent = ''
        this.pages = []
        for (let n = 1; n <= this.total; n++) {
            const el = document.createElement('div')
            el.className = 'page'
            el.dataset.page = n
            const num = document.createElement('span')
            num.className = 'num'
            num.textContent = n
            el.append(num)
            this.pagesEl.append(el)
            this.pages.push({ el, n, w: vp.width, h: vp.height, rendered: false, sized: n === 1 })
        }
        this.#relayout(false)
        this.observer = new IntersectionObserver(entries => {
            for (const e of entries) {
                const p = this.pages[+e.target.dataset.page - 1]
                if (e.isIntersecting) this.#render(p)
                else this.#release(p)
            }
        }, { root: this.container, rootMargin: '150% 0px' })
        for (const p of this.pages) this.observer.observe(p.el)
        return this
    }

    async getMetadata() {
        try {
            const { info } = await this.pdf.getMetadata()
            return { title: info?.Title || '', author: info?.Author || '' }
        } catch { return {} }
    }

    async renderCover(width = 400) {
        const page = await this.pdf.getPage(1)
        const vp1 = page.getViewport({ scale: 1 })
        const vp = page.getViewport({ scale: width / vp1.width })
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height)
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
        return canvas.toDataURL('image/jpeg', 0.85)
    }

    async getOutline() {
        const outline = await this.pdf.getOutline().catch(() => null)
        if (!outline) return []
        const resolve = async item => {
            let page = null
            try {
                let dest = item.dest
                if (typeof dest === 'string') dest = await this.pdf.getDestination(dest)
                if (Array.isArray(dest) && dest[0]) {
                    page = typeof dest[0] === 'object'
                        ? (await this.pdf.getPageIndex(dest[0])) + 1
                        : dest[0] + 1
                }
            } catch { /* ignore broken destinations */ }
            return {
                label: item.title, href: page ? `page:${page}` : null,
                subitems: await Promise.all((item.items || []).map(resolve)),
            }
        }
        return Promise.all(outline.map(resolve))
    }

    get fraction() {
        const max = this.container.scrollHeight - this.container.clientHeight
        return max > 0 ? Math.min(1, Math.max(0, this.container.scrollTop / max)) : 0
    }

    goToPage(n) {
        n = Math.min(this.total, Math.max(1, Math.round(n)))
        const p = this.pages[n - 1]
        this.container.scrollTop = p.el.offsetTop - 8
        this.#onScroll()
    }
    goToFraction(f) {
        const max = this.container.scrollHeight - this.container.clientHeight
        this.container.scrollTop = f * max
        this.#onScroll()
    }
    goTo(target) {
        if (typeof target === 'string' && target.startsWith('page:')) this.goToPage(+target.slice(5))
        else if (typeof target === 'number') this.goToPage(target)
        else if (target && typeof target.fraction === 'number') this.goToFraction(target.fraction)
    }
    next() { this.#scrollBy(this.container.clientHeight * 0.9) }
    prev() { this.#scrollBy(-this.container.clientHeight * 0.9) }
    #scrollBy(dy) { this.container.scrollBy({ top: dy, behavior: 'smooth' }); setTimeout(() => this.#onScroll(), 350) }

    setZoom(z, anchor) {
        z = Math.min(5, Math.max(0.5, z))
        if (z === this.zoom) return
        const c = this.container
        const ax = anchor?.x ?? c.clientWidth / 2
        const ay = anchor?.y ?? c.clientHeight / 2
        const ratio = z / this.zoom
        const contentX = c.scrollLeft + ax, contentY = c.scrollTop + ay
        this.zoom = z
        this.#relayout(true)
        c.scrollLeft = contentX * ratio - ax
        c.scrollTop = contentY * ratio - ay
        this.#onScroll()
        this.dispatchEvent(new CustomEvent('zoom', { detail: { zoom: z } }))
    }

    async search(query, signal) {
        const q = query.toLowerCase()
        const results = []
        for (let n = 1; n <= this.total; n++) {
            if (signal?.aborted) return results
            const page = await this.pdf.getPage(n)
            const tc = await page.getTextContent()
            const text = tc.items.map(i => i.str).join(' ').replace(/\s+/g, ' ')
            const lower = text.toLowerCase()
            let idx = lower.indexOf(q), count = 0
            while (idx !== -1 && count < 5) {
                const start = Math.max(0, idx - 40), end = Math.min(text.length, idx + q.length + 60)
                results.push({ page: n, before: text.slice(start, idx), match: text.slice(idx, idx + q.length), after: text.slice(idx + q.length, end) })
                idx = lower.indexOf(q, idx + q.length)
                count++
            }
            this.dispatchEvent(new CustomEvent('search-progress', { detail: { page: n, total: this.total, results } }))
        }
        return results
    }

    destroy() {
        this.observer?.disconnect()
        this.ro.disconnect()
        for (const p of this.pages) this.#release(p)
        this.pdf?.destroy()
    }

    // ----- internals -----

    #baseScale() {
        const avail = Math.max(100, this.container.clientWidth - 16)
        return avail / this.defaultSize.w
    }

    #relayout(rerender) {
        if (!this.pages.length) return
        const scale = this.#baseScale() * this.zoom
        this.scale = scale
        for (const p of this.pages) {
            p.el.style.width = `${Math.round(p.w * scale)}px`
            p.el.style.height = `${Math.round(p.h * scale)}px`
            if (rerender && p.rendered) p.rendered = false
        }
        this.pagesEl.style.width = `${Math.round(Math.max(...this.pages.map(p => p.w)) * scale) + 16}px`
        if (rerender) for (const p of this.pages) if (this.#isNear(p)) this.#render(p)
    }

    #isNear(p) {
        const r = p.el.getBoundingClientRect(), c = this.container.getBoundingClientRect()
        return r.bottom > c.top - c.height * 1.5 && r.top < c.bottom + c.height * 1.5
    }

    async #render(p) {
        if (p.rendering || (p.rendered && p.scaleRendered === this.scale)) return
        p.rendering = true
        try {
            const page = p.page ?? (p.page = await this.pdf.getPage(p.n))
            if (!p.sized) {
                const vp = page.getViewport({ scale: 1 })
                p.w = vp.width; p.h = vp.height; p.sized = true
                p.el.style.width = `${Math.round(p.w * this.scale)}px`
                p.el.style.height = `${Math.round(p.h * this.scale)}px`
            }
            const scale = this.scale
            let dpr = Math.min(window.devicePixelRatio || 1, 3)
            let vp = page.getViewport({ scale: scale * dpr })
            if (vp.width * vp.height > MAX_CANVAS_PIXELS) {
                dpr *= Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height))
                vp = page.getViewport({ scale: scale * dpr })
            }
            const canvas = document.createElement('canvas')
            canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height)
            p.task?.cancel()
            p.task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp })
            await p.task.promise
            p.canvas?.remove()
            p.canvas = canvas
            p.el.prepend(canvas)
            p.rendered = true
            p.scaleRendered = scale
        } catch (e) {
            if (e?.name !== 'RenderingCancelledException') console.error(e)
        } finally {
            p.rendering = false
            p.task = null
            if (p.rendered && p.scaleRendered !== this.scale && this.#isNear(p)) this.#render(p)
        }
    }

    #release(p) {
        p.task?.cancel()
        p.canvas?.remove()
        p.canvas = null
        p.rendered = false
    }

    #onScroll() {
        if (!this.pages.length) return
        const c = this.container
        const mid = c.scrollTop + c.clientHeight * 0.4
        let cur = 1
        for (const p of this.pages) {
            if (p.el.offsetTop <= mid) cur = p.n
            else break
        }
        this.current = cur
        clearTimeout(this.scrollTimer)
        this.scrollTimer = setTimeout(() => {
            this.dispatchEvent(new CustomEvent('relocate', {
                detail: { page: this.current, total: this.total, fraction: this.fraction } }))
        }, 120)
    }

    #bindGestures() {
        const c = this.container
        let pinch = null, lastTap = 0
        c.addEventListener('touchstart', e => {
            if (e.touches.length === 2) {
                const [a, b] = e.touches
                const rect = c.getBoundingClientRect()
                pinch = {
                    d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
                    cx: (a.clientX + b.clientX) / 2 - rect.left,
                    cy: (a.clientY + b.clientY) / 2 - rect.top,
                    zoom0: this.zoom, ratio: 1,
                }
                this.pagesEl.style.transformOrigin = `${c.scrollLeft + pinch.cx}px ${c.scrollTop + pinch.cy}px`
            }
        }, { passive: true })
        c.addEventListener('touchmove', e => {
            if (pinch && e.touches.length === 2) {
                e.preventDefault()
                const [a, b] = e.touches
                const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
                pinch.ratio = Math.min(5 / pinch.zoom0, Math.max(0.5 / pinch.zoom0, d / pinch.d0))
                this.pagesEl.style.transform = `scale(${pinch.ratio})`
            }
        }, { passive: false })
        const endPinch = () => {
            if (!pinch) return
            const { zoom0, ratio, cx, cy } = pinch
            pinch = null
            this.pagesEl.style.transform = ''
            this.setZoom(zoom0 * ratio, { x: cx, y: cy })
        }
        c.addEventListener('touchend', e => { if (e.touches.length < 2) endPinch() })
        c.addEventListener('touchcancel', endPinch)
        // double tap toggles zoom
        c.addEventListener('click', e => {
            const now = performance.now()
            if (now - lastTap < 300) {
                const rect = c.getBoundingClientRect()
                this.setZoom(this.zoom > 1.01 ? 1 : 2, { x: e.clientX - rect.left, y: e.clientY - rect.top })
                lastTap = 0
                e.stopPropagation()
                e.preventDefault()
            } else lastTap = now
        }, true)
    }
}
