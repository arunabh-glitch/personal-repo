// A paper page curl, in the manner of a printed book.
//
// The page corner C is carried to a point P (the finger, or an animated path). The sheet folds along the
// perpendicular bisector of C–P: up to the fold it lies flat; at the fold it bends around a cylinder of radius R
// (so the edge of the page shows the curve of real paper); past the cylinder it lies flat again, face down, on
// top of the page. The underside is plain paper. Everything is drawn in the "fold frame" (u across the fold,
// v along it) onto a transparent layer, so light and shadow apply only where paper exists, and then composited
// over whatever lies beneath: another snapshot, or the live page that the book has already moved to.
import { MAX_DPR } from './page-snapshot.js'

const PI = Math.PI
const SHADOW_SCALE = 3   // the shadow is blurred at a third of the size, which is both softer and cheaper
const MAX_TAPER = 0.035  // how fast the roll's radius may change along the fold (about 6 degrees of shear at the crest)
const easeInOut = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
const easeOut = k => 1 - Math.pow(1 - k, 3)

export class PageCurl {
    #stage; #canvas; #ctx; #layer; #lctx; #shadow; #sctx; #blank
    #W = 0; #H = 0; #L = 0; #dpr = 1
    #P = null; #raf = 0; #anim = 0; #dirty = false
    sheet = null; under = null; paper = '#ffffff'
    corner = { x: 0, y: 0 }; spine = 0

    constructor(stage) {
        this.#stage = stage
        this.#canvas = document.createElement('canvas'); this.#canvas.className = 'curl-canvas'
        this.#ctx = this.#canvas.getContext('2d')
        this.#layer = document.createElement('canvas'); this.#lctx = this.#layer.getContext('2d')
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
        const ctx = this.#ctx, lctx = this.#lctx
        const sheet = this.sheet ?? this.#blank
        const C = this.corner
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, W, H)
        if (this.under) ctx.drawImage(this.under, 0, 0, W, H)

        const dx = C.x - P.x, dy = C.y - P.y, D = Math.hypot(dx, dy)
        if (D < 0.5) { ctx.drawImage(sheet, 0, 0, W, H); return }
        // n points across the fold toward the corner, t runs along the fold
        const n = { x: dx / D, y: dy / D }, t = { x: -n.y, y: n.x }
        const RC = Math.min(this.#rMax(), D / PI)   // radius of the roll at the corner
        const arc = PI * RC                          // paper wrapped around the roll there
        const uC = (D + arc) / 2                     // the fold sits this far from the corner
        const F = { x: C.x - n.x * uC, y: C.y - n.y * uC }
        const fromFold = c => c.transform(n.x, n.y, t.x, t.y, F.x, F.y)
        const toFold = c => c.transform(n.x, t.x, n.y, t.y, -(n.x * F.x + n.y * F.y), -(t.x * F.x + t.y * F.y))
        const far = 4 * L
        // the roll is a gentle cone: widest at the corner being held, tightening toward the far end of the
        // fold. The taper is capped, so a short fold stays nearly cylindrical instead of shearing the paper.
        const vC = t.x * (C.x - F.x) + t.y * (C.y - F.y)
        const [va, vb] = this.#span(F, n, t, 0)
        let R1 = 0
        if (vb > va) {
            const vFar = Math.abs(va - vC) > Math.abs(vb - vC) ? va : vb
            if (Math.abs(vFar - vC) > 1) R1 = Math.max(-MAX_TAPER, Math.min(MAX_TAPER, (0.35 * RC - RC) / (vFar - vC)))
        }
        const Rv = v => RC + R1 * (v - vC)

        // 1. the part of the sheet still flat on the page (u <= 0)
        ctx.save(); fromFold(ctx)
        ctx.beginPath(); ctx.rect(-far, -far, far, 2 * far); ctx.clip()
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.drawImage(sheet, 0, 0, W, H)
        ctx.restore()
        if (RC < 1.5) return

        // 2. the turned paper, on its own layer: the plain underside of the page
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        lctx.globalCompositeOperation = 'source-over'
        lctx.clearRect(0, 0, W, H)
        lctx.fillStyle = this.paper
        // 2a. flat again past the roll, face down: the page reflected across the roll's crest, which runs at
        //     u = pi R(v), so the reflection carries the cone's slight shear along the fold
        lctx.save(); fromFold(lctx)
        lctx.beginPath(); lctx.rect(-far, -far, far, 2 * far); lctx.clip()
        lctx.transform(-1, 0, PI * R1, 1, PI * (RC - R1 * vC), 0); toFold(lctx); lctx.fillRect(0, 0, W, H)
        lctx.restore()
        // 2b. the roll. Seen from above only its top half shows (the rising front face is hidden under it),
        //     from the rim at a quarter turn to the top at a half turn. Its outline is traced along the fold,
        //     cut to where the page exists, and filled once, so there are no seams.
        const uSpan = v => {   // the u-interval where the page exists along the fold-parallel line at v
            const A = { x: F.x + t.x * v, y: F.y + t.y * v }
            let lo = -Infinity, hi = Infinity
            const cut = (a, dir, max) => {
                if (Math.abs(dir) < 1e-6) { if (a < 0 || a > max) { lo = 1; hi = 0 } return }
                const u1 = (0 - a) / dir, u2 = (max - a) / dir
                lo = Math.max(lo, Math.min(u1, u2)); hi = Math.min(hi, Math.max(u1, u2))
            }
            cut(A.x, n.x, W); cut(A.y, n.y, H)
            return [lo, hi]
        }
        const vs = [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => t.x * (x - F.x) + t.y * (y - F.y))
        const vMin = Math.min(...vs), vMax = Math.max(...vs)
        const rim = [], top = []
        for (let v = vMin; v <= vMax + 2; v += 2) {
            const R = Rv(v)
            if (R < 0.5) continue
            const [ua, ub] = uSpan(v)
            const lo = Math.max(PI * R / 2, ua), hi = Math.min(PI * R, ub)
            if (hi <= lo) continue
            rim.push([R * Math.sin(lo / R), v])
            top.push([R * Math.sin(hi / R) - (hi >= PI * R - 1e-6 ? 0.75 : 0), v])
        }
        if (rim.length > 1) {
            lctx.setTransform(dpr, 0, 0, dpr, 0, 0); fromFold(lctx)
            lctx.beginPath()
            lctx.moveTo(rim[0][0], rim[0][1])
            for (let i = 1; i < rim.length; i++) lctx.lineTo(rim[i][0], rim[i][1])
            for (let i = top.length - 1; i >= 0; i--) lctx.lineTo(top[i][0], top[i][1])
            lctx.closePath(); lctx.fill()
        }
        // 2c. light: the underside is a shade off the page it lies on; the roll is lit on top and falls into
        //     shadow at its rim
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        lctx.globalCompositeOperation = 'source-atop'
        lctx.fillStyle = this.#dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'
        lctx.fillRect(0, 0, W, H)
        fromFold(lctx)
        let g = lctx.createLinearGradient(0, 0, RC, 0)
        g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.22, 'rgba(255,255,255,0.10)')
        g.addColorStop(0.55, 'rgba(0,0,0,0.06)'); g.addColorStop(1, 'rgba(0,0,0,0.30)')
        lctx.fillStyle = g; lctx.fillRect(0, -far, RC, 2 * far)
        g = lctx.createLinearGradient(-0.6 * RC, 0, 0, 0)
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.04)')
        lctx.fillStyle = g; lctx.fillRect(-0.6 * RC, -far, 0.6 * RC, 2 * far)
        lctx.globalCompositeOperation = 'source-over'

        // 3. the shadow the paper casts: its own silhouette, blurred, so it follows the fold and the curve of the
        //    edge and falls on whatever lies beneath. Drawn at a third of the size; the image itself lands far out
        //    of view and only its shadow shows.
        const sc = this.#shadow, sctx = this.#sctx, k = SHADOW_SCALE
        sctx.setTransform(1, 0, 0, 1, 0, 0)
        sctx.clearRect(0, 0, sc.width, sc.height)
        sctx.save()
        sctx.shadowColor = 'rgba(0,0,0,0.42)'
        sctx.shadowBlur = Math.max(4, Math.min(10, RC / k))
        sctx.shadowOffsetX = 4000 + 4 / k; sctx.shadowOffsetY = 4000 + 7 / k
        sctx.drawImage(this.#layer, -4000, -4000, W / k, H / k)
        sctx.restore()
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.drawImage(sc, 0, 0, W, H)
        // 4. the paper itself
        ctx.drawImage(this.#layer, 0, 0, W, H)
    }

    get #dark() {
        const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(this.paper || '')
        return m ? (parseInt(m[1], 16) * 299 + parseInt(m[2], 16) * 587 + parseInt(m[3], 16) * 114) / 255000 < 0.5 : false
    }

    // The v-interval where the line u = d (in the fold frame) crosses the page rectangle.
    #span(F, n, t, d) {
        const A = { x: F.x + n.x * d, y: F.y + n.y * d }
        let lo = -Infinity, hi = Infinity
        const cut = (a, dir, max) => {
            if (Math.abs(dir) < 1e-6) { if (a < 0 || a > max) { lo = 1; hi = 0 } return }
            const v1 = (0 - a) / dir, v2 = (max - a) / dir
            lo = Math.max(lo, Math.min(v1, v2)); hi = Math.min(hi, Math.max(v1, v2))
        }
        cut(A.x, t.x, this.#W); cut(A.y, t.y, this.#H)
        return [lo, hi]
    }
}

export { easeOut, easeInOut }
