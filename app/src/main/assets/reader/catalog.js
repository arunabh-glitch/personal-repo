// Free book catalogs reachable directly from the browser (both send CORS headers).
//  - Project Gutenberg via the Gutendex API
//  - Internet Archive texts
import { library } from './store.js'

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
const fetchJSON = async (url) => {
    const res = await withTimeout(fetch(url, { headers: { Accept: 'application/json' } }), 15000)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
}

export const SOURCES = {
    gutenberg: {
        name: 'Project Gutenberg',
        blurb: '70,000+ free classics',
        async search(query, page = 1) {
            const q = query.trim()
            const data = await fetchJSON(q ? `https://gutendex.com/books/?search=${encodeURIComponent(q)}&page=${page}` : `https://gutendex.com/books/?sort=popular&page=${page}`)
            return {
                more: !!data.next,
                items: (data.results || []).map(b => {
                    const f = b.formats || {}
                    const epub = f['application/epub+zip'] || Object.entries(f).find(([k, v]) => k.startsWith('application/epub') && !v.endsWith('.zip'))?.[1]
                    const fmt = epub ? { url: epub, type: 'application/epub+zip', ext: 'epub' }
                        : f['text/plain; charset=utf-8'] ? { url: f['text/plain; charset=utf-8'], type: 'text/plain', ext: 'txt' }
                        : f['text/plain'] ? { url: f['text/plain'], type: 'text/plain', ext: 'txt' } : null
                    return {
                        id: `pg${b.id}`, title: b.title, author: (b.authors || []).map(a => a.name.replace(/^(.+), (.+)$/, '$2 $1')).join(', '),
                        cover: f['image/jpeg'] || null, downloads: b.download_count, language: (b.languages || [])[0],
                        file: fmt, page: `https://www.gutenberg.org/ebooks/${b.id}`,
                    }
                }).filter(x => x.file),
            }
        },
    },
    archive: {
        name: 'Internet Archive',
        blurb: 'millions of scanned and digital books',
        async search(query, page = 1) {
            const q = query.trim() ? `(${query.trim()}) AND mediatype:texts` : 'mediatype:texts AND collection:gutenberg'
            const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&fl[]=language&rows=20&page=${page}&sort[]=downloads+desc&output=json`
            const data = await fetchJSON(url)
            const docs = data.response?.docs || []
            return {
                more: docs.length === 20,
                items: docs.map(d => ({
                    id: `ia:${d.identifier}`, title: d.title || d.identifier, author: Array.isArray(d.creator) ? d.creator.join(', ') : (d.creator || ''),
                    cover: `https://archive.org/services/img/${d.identifier}`, downloads: d.downloads, language: Array.isArray(d.language) ? d.language[0] : d.language,
                    file: null, identifier: d.identifier, page: `https://archive.org/details/${d.identifier}`,
                })),
            }
        },
        async resolve(item) {
            const meta = await fetchJSON(`https://archive.org/metadata/${item.identifier}`)
            const files = meta.files || []
            const pick = (re, type, ext) => { const f = files.find(f => re.test(f.name) && !/_text\.pdf$/.test(f.name)); return f ? { url: `https://archive.org/download/${item.identifier}/${encodeURIComponent(f.name)}`, type, ext } : null }
            return pick(/\.epub$/i, 'application/epub+zip', 'epub') || pick(/\.pdf$/i, 'application/pdf', 'pdf') || pick(/_djvu\.txt$/i, 'text/plain', 'txt') || pick(/\.txt$/i, 'text/plain', 'txt')
        },
    },
}

export const downloadToShelf = async (source, item, onProgress = () => {}) => {
    const file = item.file || (SOURCES[source].resolve ? await SOURCES[source].resolve(item) : null)
    if (!file) throw new Error('No readable file for this title')
    const res = await fetch(file.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const total = +res.headers.get('content-length') || 0
    let blob
    if (res.body && total) {
        const reader = res.body.getReader(); const chunks = []; let got = 0
        for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProgress(got, total) }
        blob = new Blob(chunks, { type: file.type })
    } else blob = await res.blob()
    const name = `${item.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80)}.${file.ext}`
    const book = await library.importFile(new File([blob], name, { type: file.type }), item.page)
    if (item.author) await library.update(book.id, { author: item.author })
    return book
}
