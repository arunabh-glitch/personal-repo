// Draws the visible page of a foliate-view onto a canvas: text word by word where the browser laid it out,
// images, box backgrounds and borders, and the highlight overlay. It stands in for the page for the half second
// a page turn takes. The canvas belongs to the book's own document, so any font the book brings along resolves.
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'HEAD', 'TITLE', 'META', 'LINK'])
const TRANSPARENT = /^(transparent|rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\))$/
export const MAX_DPR = 2

export function snapshotPage(view, paper) {
    const host = view.getBoundingClientRect()
    const W = Math.max(1, Math.round(host.width)), H = Math.max(1, Math.round(host.height))
    const dpr = Math.min(devicePixelRatio || 1, MAX_DPR)
    const { doc, overlayer } = view.renderer?.getContents?.()[0] ?? {}
    const canvas = (doc ?? document).createElement('canvas')
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.fillStyle = paper
    ctx.fillRect(0, 0, W, H)
    if (doc?.body) try { paint(ctx, doc, overlayer, host, W, H) } catch (e) { console.warn('page snapshot', e) }
    return canvas
}

function paint(ctx, doc, overlayer, host, W, H) {
    const win = doc.defaultView
    const fr = win?.frameElement?.getBoundingClientRect() ?? { left: host.left, top: host.top }
    const ox = fr.left - host.left, oy = fr.top - host.top   // book coordinates → page coordinates
    const onPage = r => r.width > 0 && r.height > 0 && r.right + ox > 0 && r.left + ox < W && r.bottom + oy > 0 && r.top + oy < H
    const styles = new Map()
    const styleOf = el => { let s = styles.get(el); if (!s) { s = win.getComputedStyle(el); styles.set(el, s) } return s }
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: node => {
            if (node.nodeType !== 1) return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
            if (SKIP.has(node.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT
            if (!node.getClientRects().length) return NodeFilter.FILTER_REJECT
            const r = node.getBoundingClientRect()
            // a real box that lies elsewhere takes its subtree with it; empty boxes may still hold floats
            if (r.width > 0 && r.height > 0 && !onPage(r)) return NodeFilter.FILTER_REJECT
            return NodeFilter.FILTER_ACCEPT
        },
    })
    const range = doc.createRange()
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === 1) paintBox(ctx, node, styleOf(node), ox, oy, onPage)
        else paintText(ctx, node, range, styleOf(node.parentElement), ox, oy, onPage)
    }
    paintOverlay(ctx, overlayer, ox, oy)
}

function paintBox(ctx, el, s, ox, oy, onPage) {
    if (s.visibility === 'hidden') return
    if (el.tagName.toUpperCase() === 'IMG') {
        if (!el.complete || !el.naturalWidth) return
        const r = el.getBoundingClientRect()
        if (onPage(r)) try { ctx.drawImage(el, r.left + ox, r.top + oy, r.width, r.height) } catch { /* cross-origin */ }
        return
    }
    const bg = s.backgroundColor, hasBg = bg && !TRANSPARENT.test(bg)
    const sides = ['Top', 'Right', 'Bottom', 'Left']
    const bw = sides.map(side => s[`border${side}Style`] === 'none' ? 0 : parseFloat(s[`border${side}Width`]) || 0)
    if (!hasBg && !bw.some(Boolean)) return
    for (const r of el.getClientRects()) {
        if (!onPage(r)) continue
        const x = r.left + ox, y = r.top + oy, w = r.width, h = r.height
        if (hasBg) { ctx.fillStyle = bg; ctx.fillRect(x, y, w, h) }
        const [t, rt, b, l] = bw
        if (t) { ctx.fillStyle = s.borderTopColor; ctx.fillRect(x, y, w, t) }
        if (b) { ctx.fillStyle = s.borderBottomColor; ctx.fillRect(x, y + h - b, w, b) }
        if (l) { ctx.fillStyle = s.borderLeftColor; ctx.fillRect(x, y, l, h) }
        if (rt) { ctx.fillStyle = s.borderRightColor; ctx.fillRect(x + w - rt, y, rt, h) }
    }
}

const rectsOf = range => Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0)

function paintText(ctx, node, range, s, ox, oy, onPage) {
    if (!s || s.visibility === 'hidden' || s.display === 'none') return
    const text = node.nodeValue
    ctx.font = `${s.fontStyle} ${s.fontVariantCaps === 'small-caps' ? 'small-caps' : 'normal'} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
    if ('letterSpacing' in ctx) ctx.letterSpacing = s.letterSpacing === 'normal' ? '0px' : s.letterSpacing
    ctx.fillStyle = s.color
    const transform = s.textTransform, deco = s.textDecorationLine || ''
    const px = parseFloat(s.fontSize) || 16
    const draw = (str, r, hyphen) => {
        if (!onPage(r)) return
        if (transform === 'uppercase') str = str.toUpperCase()
        else if (transform === 'lowercase') str = str.toLowerCase()
        else if (transform === 'capitalize') str = str[0].toUpperCase() + str.slice(1)
        str = str.replace(/­/g, '')
        if (!str) return
        const m = ctx.measureText(str)
        const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? r.height * 0.8
        const desc = m.fontBoundingBoxDescent ?? r.height * 0.2
        const x = r.left + ox, y = r.top + oy + (r.height - (asc + desc)) / 2 + asc
        const shown = hyphen && !/[-‐‑]$/.test(str) ? str + '-' : str
        // a substituted font is stretched to the width the browser used, so the line still reads as laid out
        const k = m.width > 0 ? r.width / m.width : 1
        if (k > 0.6 && k < 1.6 && Math.abs(k - 1) > 0.02) {
            ctx.save(); ctx.translate(x, 0); ctx.scale(k, 1); ctx.fillText(shown, 0, y); ctx.restore()
        } else ctx.fillText(shown, x, y)
        if (deco.includes('underline')) ctx.fillRect(x, y + Math.max(1, desc * 0.35), r.width, Math.max(1, px / 16))
        if (deco.includes('line-through')) ctx.fillRect(x, y - asc * 0.3, r.width, Math.max(1, px / 16))
    }
    const re = /\S+/g
    let m
    while ((m = re.exec(text))) {
        let start = m.index
        const end = start + m[0].length
        while (start < end) {
            range.setStart(node, start); range.setEnd(node, end)
            let rects = rectsOf(range), next = end, hyphen = false
            if (rects.length > 1) {
                // the word wraps (hyphenation or a forced break): the longest prefix that stays on one line
                let lo = start + 1, hi = end - 1
                while (lo < hi) {
                    const mid = (lo + hi + 1) >> 1
                    range.setEnd(node, mid)
                    if (rectsOf(range).length > 1) hi = mid - 1; else lo = mid
                }
                range.setEnd(node, lo)
                rects = rectsOf(range); next = lo; hyphen = true
            }
            if (!rects[0]) break
            draw(text.slice(start, next), rects[0], hyphen)
            start = next
        }
    }
}

function paintOverlay(ctx, overlayer, ox, oy) {
    const svg = overlayer?.element
    if (!svg) return
    for (const g of svg.querySelectorAll('g')) {
        const fill = g.getAttribute('fill'), stroke = g.getAttribute('stroke')
        for (const el of g.children) {
            if (el.tagName !== 'rect') continue
            const x = +el.getAttribute('x') + ox, y = +el.getAttribute('y') + oy
            const w = +el.getAttribute('width'), h = +el.getAttribute('height')
            if (fill && fill !== 'none') { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h) }
            if (stroke && stroke !== 'none') { ctx.strokeStyle = stroke; ctx.lineWidth = +g.getAttribute('stroke-width') || 1; ctx.strokeRect(x, y, w, h) }
        }
    }
}
