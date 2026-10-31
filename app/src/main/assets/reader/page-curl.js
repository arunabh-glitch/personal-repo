// A paper page curl, in the manner of a printed book.
//
// The page corner C is carried to a point P (the finger, or an animated path). The sheet folds along the
// perpendicular bisector of C–P: up to the fold it lies flat; at the fold it bends around a cylinder of radius R
// (so the edge of the page shows the curve of real paper); past the cylinder it lies flat again, face down, on
// top of the page. Everything is drawn in the "fold frame" (u across the fold, v along it) onto a transparent
// layer, so shading can be applied only where paper exists, and then composited over whatever lies beneath:
// another snapshot, or the live page that the book has already moved to.
import { MAX_DPR } from './page-snapshot.js'

const PI = Math.PI
const SHADOW_SCALE = 3   // the shadow is blurred at a third of the size, which is both softer and cheaper
const easeInOut = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
const easeOut = k => 1 - Math.pow(1 - k, 3)
const rgba = (hex, a) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '')
    return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : `rgba(255,255,255,${a})`
}

export class PageCurl {
    #stage; #canvas; #ctx; #layer; #lctx; #band; #bctx; #shadow; #sctx; #blank
    #W = 0; #H = 0; #L = 0; #dpr = 1
    #P = null; #raf = 0; #anim = 0; #dirty = false
    sheet = null; under = null; paper = '#ffffff'
    corner = { x: 0, y: 0 }; spine = 0

    constructor(stage) {
        this.#stage = stage
        this.#canvas = document.createElement('canvas'); this.#canvas.className = 'curl-canvas'
        this.#ctx = this.#canvas.getContext('2d')
        this.#layer = document.createElement('canvas'); this.#lctx = this.#layer.getContext('2d')
        this.#band = document.createElement('canvas'); this.#bctx = this.#band.getContext('2d')
        this.#shadow = document.createElement('canvas'); this.#sctx = this.#shadow.getContext('2d')
    }

    get point() { return this.#P }
    get active() { return this.#canvas.isConnected }

    // sheet: canvas of the page being turned (null = blank paper until one arrives); under: what lies beneath
    // (null = the live page); corner: the page corner that travels; spine: x of the bound edge.
    begin({ sheet = null, under = null, paper, corner, spine, start }) {
        const r = this.#stage.getBoundingClientRect()
        this.#W = Math.max(1, Math.round(r.width)); this.#H = Math.max(1, Math.round(r.height))
        this.#L = Math.ceil(Math.hypot(this.#W, this.#H))
        this.#dpr = Math.min(devicePixelRatio || 1, MAX_DPR)
        const { W, H, L, dpr } = { W: this.#W, H: this.#H, L: this.#L, dpr: this.#dpr }
        this.#size(this.#canvas, W, H)
        this.#size(this.#layer, W, H)
        this.#size(this.#band, Math.ceil(PI * this.#rMax() + 4), 2 * L)
        this.#shadow.width = Math.ceil(W / SHADOW_SCALE); this.#shadow.height = Math.ceil(H / SHADOW_SCALE)
        this.#blank = document.createElement('canvas'); this.#size(this.#blank, W, H)
        const bc = this.#blank.getContext('2d'); bc.scale(dpr, dpr); bc.fillStyle = paper; bc.fillRect(0, 0, W, H)
        Object.assign(this, { sheet, under, paper, corner, spine })
        this.#stage.append(this.#canvas)
        this.setPoint(start ?? corner, true)
    }

    setPoint(P, now = false) {
        this.#P = { x: P.x, y: P.y }
        if (now) { this.#draw(); return }
        this.#dirty = true
        if (!this.#raf) this.#raf = requestAnimationFrame(() => { this.#raf = 0; if (this.#dirty) { this.#dirty = false; this.#draw() } })
    }

    refresh() { if (this.#P) this.setPoint(this.#P) }

    // Carries the corner from where it is to P1. lift bows the path toward the middle of the page.
    animateTo(P1, { duration = 450, lift = 0, ease = easeInOut } = {}) {
        this.#stopAnim()
        const P0 = { ...this.#P }, t0 = performance.now()
        return new Promise(resolve => {
            const step = now => {
                const k = Math.min(1, (now - t0) / duration), e = ease(k)
                this.setPoint({ x: P0.x + (P1.x - P0.x) * e, y: P0.y + (P1.y - P0.y) * e - lift * Math.sin(PI * k) }, true)
                if (k < 1) this.#anim = requestAnimationFrame(step)
                else { this.#anim = 0; resolve() }
            }
            this.#anim = requestAnimationFrame(step)
        })
    }

    end() {
        this.#stopAnim()
        if (this.#raf) { cancelAnimationFrame(this.#raf); this.#raf = 0 }
        this.#canvas.remove()
        this.sheet = this.under = this.#blank = null
        this.#P = null
    }

    #stopAnim() { if (this.#anim) { cancelAnimationFrame(this.#anim); this.#anim = 0 } }
    #size(c, w, h) { c.width = Math.round(w * this.#dpr); c.height = Math.round(h * this.#dpr) }
    #rMax() { return Math.max(24, Math.min(this.#W, this.#H) * 0.17) }

    #draw() {
        const P = this.#P
        if (!P) return
        const { W, H, L, dpr } = { W: this.#W, H: this.#H, L: this.#L, dpr: this.#dpr }
        const ctx = this.#ctx, lctx = this.#lctx, bctx = this.#bctx
        const sheet = this.sheet ?? this.#blank
        const C = this.corner
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, W, H)
        if (this.under) ctx.drawImage(this.under, 0, 0, W, H)

        const dx = C.x - P.x, dy = C.y - P.y, D = Math.hypot(dx, dy)
        if (D < 0.5) { ctx.drawImage(sheet, 0, 0, W, H); return }
        // n points across the fold toward the corner, t runs along the fold
        const n = { x: dx / D, y: dy / D }, t = { x: -n.y, y: n.x }
        const R = Math.min(this.#rMax(), D / PI)
        const arc = PI * R                      // paper wrapped around the cylinder
        const uC = (D + arc) / 2                // the fold sits this far from the corner
        const F = { x: C.x - n.x * uC, y: C.y - n.y * uC }
        const fromFold = c => c.transform(n.x, n.y, t.x, t.y, F.x, F.y)
        const toFold = c => c.transform(n.x, t.x, n.y, t.y, -(n.x * F.x + n.y * F.y), -(t.x * F.x + t.y * F.y))
        const far = 4 * L

        // 1. the part of the sheet still flat on the page (u <= 0)
        ctx.save(); fromFold(ctx)
        ctx.beginPath(); ctx.rect(-far, -far, far, 2 * far); ctx.clip()
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.drawImage(sheet, 0, 0, W, H)
        ctx.restore()
        if (R < 1.5) return

        // 2. the band of paper on the cylinder, in fold coordinates (u in [0, arc]), shaded on both faces
        const bh = 2 * L
        bctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        bctx.globalCompositeOperation = 'source-over'
        bctx.clearRect(0, 0, arc + 4, bh)
        bctx.save(); bctx.translate(0, L); toFold(bctx); bctx.drawImage(sheet, 0, 0, W, H); bctx.restore()
        bctx.globalCompositeOperation = 'source-atop'
        // the front face dims gently into the bend; the back face is the paper's underside, brightest at the crest
        let g = bctx.createLinearGradient(0, 0, arc / 2, 0)
        g.addColorStop(0, 'rgba(0,0,0,0.11)'); g.addColorStop(0.6, 'rgba(0,0,0,0.02)'); g.addColorStop(1, 'rgba(0,0,0,0)')
        bctx.fillStyle = g; bctx.fillRect(0, 0, arc / 2, bh)
        bctx.fillStyle = rgba(this.paper, 0.86); bctx.fillRect(arc / 2, 0, arc / 2 + 2, bh)
        g = bctx.createLinearGradient(arc / 2, 0, arc, 0)
        g.addColorStop(0, 'rgba(255,255,255,0.08)'); g.addColorStop(0.4, 'rgba(0,0,0,0.02)'); g.addColorStop(1, 'rgba(0,0,0,0.13)')
        bctx.fillStyle = g; bctx.fillRect(arc / 2, 0, arc / 2 + 2, bh)

        // 3. the turned paper, on its own layer
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        lctx.globalCompositeOperation = 'source-over'
        lctx.clearRect(0, 0, W, H)
        // 3a. flat again past the cylinder, face down: mirrored across the crest, landing at u' = arc - u <= 0
        lctx.save(); fromFold(lctx)
        lctx.beginPath(); lctx.rect(-far, -far, far, 2 * far); lctx.clip()
        lctx.transform(-1, 0, 0, 1, arc, 0); toFold(lctx); lctx.drawImage(sheet, 0, 0, W, H)
        lctx.restore()
        lctx.save(); lctx.globalCompositeOperation = 'source-atop'
        lctx.fillStyle = rgba(this.paper, 0.86); lctx.fillRect(0, 0, W, H)
        fromFold(lctx)
        g = lctx.createLinearGradient(-2.2 * R, 0, 0, 0)
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.55, 'rgba(0,0,0,0.05)'); g.addColorStop(1, 'rgba(0,0,0,0.13)')
        lctx.fillStyle = g; lctx.fillRect(-2.2 * R, -far, 2.2 * R, 2 * far)
        lctx.restore()
        // 3b. the cylinder, as thin strips: the back face comes over the top, the front face rises beneath it
        lctx.save(); fromFold(lctx)
        const step = 1.25
        const strip = (u, w) => {
            const th = u / R, up = R * Math.sin(th), c = Math.cos(th)
            const wp = Math.max(0.8, w * Math.abs(c)) + 0.6
            lctx.drawImage(this.#band, u * dpr, 0, w * dpr, bh * dpr, c >= 0 ? up : up - wp + 0.6, -L, wp, bh)
        }
        for (let u = arc - step; u >= arc / 2 - step; u -= step) strip(Math.max(0, u), step)
        lctx.globalCompositeOperation = 'destination-over'
        for (let u = 0; u < arc / 2; u += step) strip(u, step)
        lctx.restore()

        // 4. the shadow the paper casts: its own silhouette, blurred, so it follows the fold and the curve of the
        //    edge and falls on whatever lies beneath. Drawn at a third of the size; the image itself lands far out
        //    of view and only its shadow shows.
        const sc = this.#shadow, sctx = this.#sctx, k = SHADOW_SCALE
        sctx.setTransform(1, 0, 0, 1, 0, 0)
        sctx.clearRect(0, 0, sc.width, sc.height)
        sctx.save()
        sctx.shadowColor = 'rgba(0,0,0,0.42)'
        sctx.shadowBlur = Math.max(4, Math.min(10, R / k))
        sctx.shadowOffsetX = 4000 + 4 / k; sctx.shadowOffsetY = 4000 + 7 / k
        sctx.drawImage(this.#layer, -4000, -4000, W / k, H / k)
        sctx.restore()
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.drawImage(sc, 0, 0, W, H)
        // 5. the paper itself
        ctx.drawImage(this.#layer, 0, 0, W, H)
    }
}

export { easeOut, easeInOut }
