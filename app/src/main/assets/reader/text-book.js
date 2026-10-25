// Adapter that turns plain text, Markdown and HTML files into the "book"
// interface consumed by foliate-js's <foliate-view>.

export const TEXT_FORMATS = ['txt', 'text', 'md', 'markdown', 'html', 'htm', 'xhtml']
export const isTextFormat = f => TEXT_FORMATS.includes((f || '').toLowerCase())

const MAX_SECTION = 60_000 // characters per section (keeps pagination fast)

const escapeHTML = s => s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const baseCSS = `
    html { font-family: serif; }
    body { margin: 0; padding: 0 0.5em; }
    p { margin: 0 0 0.9em; }
    h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 0.6em; }
    h1 { font-size: 1.7em; } h2 { font-size: 1.4em; } h3 { font-size: 1.2em; }
    pre { white-space: pre-wrap; word-wrap: break-word; font-size: 0.85em; background: rgba(127,127,127,0.12); padding: 0.6em; border-radius: 4px; }
    code { font-size: 0.9em; background: rgba(127,127,127,0.12); padding: 0 0.2em; border-radius: 3px; }
    blockquote { margin: 0.8em 0; padding-left: 1em; border-left: 3px solid rgba(127,127,127,0.5); }
    img { max-width: 100%; height: auto; }
    hr { border: 0; border-top: 1px solid rgba(127,127,127,0.4); margin: 1.5em 0; }
    table { border-collapse: collapse; } td, th { border: 1px solid rgba(127,127,127,0.4); padding: 0.2em 0.5em; }
`

const wrap = (title, body) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${escapeHTML(title)}</title><style>${baseCSS}</style></head><body>${body}</body></html>`

const decode = async blob => {
    const buf = await blob.arrayBuffer()
    const bytes = new Uint8Array(buf)
    // BOM sniffing
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf)
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf)
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) }
    catch { return new TextDecoder('windows-1252').decode(buf) }
}

// ---------- plain text ----------

const HEADING_RE = /^\s*(chapter|part|book|prologue|epilogue|section|canto|act|scene|letter|stave|volume)\b[^\n]{0,80}$/i
const ROMAN_RE = /^\s*[IVXLCDM]{1,8}\.?\s*$/
const isHeadingLine = line => {
    const t = line.trim()
    if (!t || t.length > 80) return false
    if (HEADING_RE.test(t) || ROMAN_RE.test(t)) return true
    const letters = t.replace(/[^A-Za-z]/g, '')
    return letters.length >= 3 && letters.length <= 50 && letters === letters.toUpperCase()
        && t.length <= 60 && !/[.!?]$/.test(t)
}

const textToBlocks = text => {
    text = text.replace(/\r\n?/g, '\n')
    const byBlank = text.split(/\n[ \t]*\n+/)
    const lines = text.split('\n')
    // If there are hardly any blank lines, treat every line as a paragraph.
    const paras = byBlank.length > lines.length / 25 || lines.length < 50
        ? byBlank.map(p => p.replace(/\s*\n\s*/g, ' ').trim())
        : lines.map(l => l.trim())
    return paras.filter(Boolean)
}

const buildFromBlocks = (blocks, title) => {
    const sections = []
    let cur = { html: '', chars: 0, heading: null, headings: [] }
    let secIndex = 0, hid = 0
    const flush = () => {
        if (!cur.chars) return
        const id = `s${secIndex++}`
        sections.push({ id, title: cur.heading ?? (secIndex === 1 ? title : `Part ${secIndex}`),
            html: wrap(title, cur.html), headings: cur.headings })
        cur = { html: '', chars: 0, heading: null, headings: [] }
    }
    for (const b of blocks) {
        const heading = isHeadingLine(b)
        if (heading && cur.chars > 1500) flush()
        if (heading) {
            const id = `h${hid++}`
            cur.html += `<h2 id="${id}">${escapeHTML(b)}</h2>`
            cur.headings.push({ label: b, id })
            if (!cur.heading) cur.heading = b
        } else {
            cur.html += `<p>${escapeHTML(b)}</p>`
        }
        cur.chars += b.length
        if (cur.chars > MAX_SECTION) flush()
    }
    flush()
    return sections
}

// ---------- markdown (small, dependency-free subset) ----------

const inline = s => {
    s = escapeHTML(s)
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<em>[$1]</em>')
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>')
    s = s.replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>')
    s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1<em>$2</em>') // no lookbehind: older iOS Safari
    s = s.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    s = s.replace(/~~(.+?)~~/g, '<del>$1</del>')
    return s
}

const markdownToHTML = md => {
    const lines = md.replace(/\r\n?/g, '\n').split('\n')
    const out = []
    const headings = []
    let i = 0, hid = 0, para = [], list = null
    const closePara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = [] } }
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
    while (i < lines.length) {
        const line = lines[i]
        if (/^\s*```/.test(line)) {
            closePara(); closeList()
            const code = []
            i++
            while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
            i++
            out.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`)
            continue
        }
        const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
        if (h) {
            closePara(); closeList()
            const level = h[1].length, id = `h${hid++}`
            out.push(`<h${level} id="${id}">${inline(h[2])}</h${level}>`)
            headings.push({ label: h[2].replace(/[*_`]/g, ''), id, level })
            i++; continue
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { closePara(); closeList(); out.push('<hr>'); i++; continue }
        const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
        const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
        if (ul || ol) {
            closePara()
            const tag = ul ? 'ul' : 'ol'
            if (list !== tag) { closeList(); out.push(`<${tag}>`); list = tag }
            out.push(`<li>${inline((ul || ol)[1])}</li>`)
            i++; continue
        }
        const bq = /^\s*>\s?(.*)$/.exec(line)
        if (bq) {
            closePara(); closeList()
            const q = []
            while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''))
            out.push(`<blockquote>${markdownToHTML(q.join('\n')).html}</blockquote>`)
            continue
        }
        if (!line.trim()) { closePara(); closeList(); i++; continue }
        // setext headings
        if (i + 1 < lines.length && /^\s*(=+|-+)\s*$/.test(lines[i + 1]) && !para.length) {
            const level = lines[i + 1].trim()[0] === '=' ? 1 : 2, id = `h${hid++}`
            closeList()
            out.push(`<h${level} id="${id}">${inline(line.trim())}</h${level}>`)
            headings.push({ label: line.trim(), id, level })
            i += 2; continue
        }
        closeList()
        para.push(line.trim())
        i++
    }
    closePara(); closeList()
    return { html: out.join('\n'), headings }
}

// ---------- html ----------

const sanitizeHTML = (src, title) => {
    const doc = new DOMParser().parseFromString(src, 'text/html')
    doc.querySelectorAll('script, iframe, object, embed, link[rel="stylesheet"][href^="http"]').forEach(el => el.remove())
    doc.querySelectorAll('[onclick],[onload],[onerror]').forEach(el => {
        for (const a of Array.from(el.attributes)) if (a.name.startsWith('on')) el.removeAttribute(a.name)
    })
    const headings = []
    doc.querySelectorAll('h1, h2, h3').forEach((h, n) => {
        if (!h.id) h.id = `h${n}`
        headings.push({ label: h.textContent.trim(), id: h.id, level: +h.tagName[1] })
    })
    const style = doc.createElement('style')
    style.textContent = baseCSS
    doc.head.prepend(style)
    if (!doc.title) doc.title = title
    return { html: '<!DOCTYPE html>' + doc.documentElement.outerHTML, headings }
}

// ---------- book ----------

const splitHeadingsHTML = ({ html, headings }, title) => {
    // Single section unless the document is large: then split on h1/h2.
    if (html.length <= MAX_SECTION * 1.5 || !headings.length)
        return [{ id: 's0', title, html: html.startsWith('<!DOCTYPE') ? html : wrap(title, html), headings }]
    const doc = new DOMParser().parseFromString(html.startsWith('<!DOCTYPE') ? html : wrap(title, html), 'text/html')
    const sections = []
    let cur = [], curHeadings = [], curTitle = title
    const flush = () => {
        if (!cur.length) return
        sections.push({ id: `s${sections.length}`, title: curTitle,
            html: wrap(title, cur.map(n => n.outerHTML ?? escapeHTML(n.textContent)).join('')), headings: curHeadings })
        cur = []; curHeadings = []
    }
    for (const node of Array.from(doc.body.childNodes)) {
        if (node.nodeType === 1 && /^H[12]$/.test(node.tagName) && cur.length > 5) { flush(); curTitle = node.textContent.trim() }
        if (node.nodeType === 1 && /^H[1-3]$/.test(node.tagName) && node.id) curHeadings.push({ label: node.textContent.trim(), id: node.id, level: +node.tagName[1] })
        cur.push(node)
    }
    flush()
    return sections
}

export const makeTextBook = async (blob, name, format) => {
    const title = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ')
    const text = await decode(blob)
    const fmt = (format || name.split('.').pop() || 'txt').toLowerCase()
    let raw
    if (fmt === 'md' || fmt === 'markdown') raw = splitHeadingsHTML(markdownToHTML(text), title)
    else if (fmt === 'html' || fmt === 'htm' || fmt === 'xhtml') raw = splitHeadingsHTML(sanitizeHTML(text, title), title)
    else raw = buildFromBlocks(textToBlocks(text), title)

    const urls = new Map()
    const sections = raw.map(s => ({
        id: s.id,
        linear: 'yes',
        size: s.html.length,
        load: () => {
            if (!urls.has(s.id)) urls.set(s.id, URL.createObjectURL(new Blob([s.html], { type: 'text/html' })))
            return urls.get(s.id)
        },
        unload: () => { const u = urls.get(s.id); if (u) { URL.revokeObjectURL(u); urls.delete(s.id) } },
        createDocument: () => new DOMParser().parseFromString(s.html, 'text/html'),
    }))

    const toc = []
    for (const s of raw) {
        if (s.headings.length) {
            const top = s.headings[0]
            const item = { label: top.label, href: `${s.id}#${top.id}`, subitems: [] }
            for (const h of s.headings.slice(1)) item.subitems.push({ label: h.label, href: `${s.id}#${h.id}` })
            // Flatten mostly: headings beyond the first become sub-items.
            toc.push(item)
        } else toc.push({ label: s.title, href: s.id })
    }

    return {
        metadata: { title },
        sections, toc, dir: 'ltr', rendition: {},
        resolveHref(href) {
            const [id, frag] = href.split('#')
            const index = Math.max(0, sections.findIndex(s => s.id === id))
            return { index, anchor: doc => (frag ? doc.getElementById(frag) : null) ?? doc.body }
        },
        splitTOCHref(href) { return href.split('#') },
        getTOCFragment(doc, frag) { return (frag ? doc.getElementById(frag) : null) ?? doc.documentElement },
        isExternal: href => /^(https?|mailto|tel):/i.test(href),
        destroy() { for (const u of urls.values()) URL.revokeObjectURL(u); urls.clear() },
    }
}
