// IndexedDB-backed library used by the web (iPhone / browser) build.
// Two stores: `books` (metadata + cover blob) and `files` (the book file).

const DB_NAME = 'openshelf'
const DB_VERSION = 1

const FORMATS = {
    epub: 'application/epub+zip', pdf: 'application/pdf', mobi: 'application/x-mobipocket-ebook',
    azw: 'application/x-mobipocket-ebook', azw3: 'application/vnd.amazon.mobi8-ebook', kf8: 'application/vnd.amazon.mobi8-ebook',
    prc: 'application/x-mobipocket-ebook', fb2: 'application/x-fictionbook+xml', fbz: 'application/x-zip-compressed-fb2',
    cbz: 'application/vnd.comicbook+zip', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
    html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml',
}
const MIME_TO_FORMAT = Object.fromEntries(Object.entries(FORMATS).map(([k, v]) => [v, k]))
MIME_TO_FORMAT['application/vnd.amazon.ebook'] = 'azw3'
MIME_TO_FORMAT['application/x-cbz'] = 'cbz'

export const SUPPORTED_EXTENSIONS = Object.keys(FORMATS)
export const ACCEPT = SUPPORTED_EXTENSIONS.map(e => '.' + e).concat(Object.values(FORMATS)).join(',')

export const detectFormat = (name, mime) => {
    const lower = (name || '').toLowerCase()
    if (lower.endsWith('.fb2.zip')) return 'fbz'
    const ext = lower.includes('.') ? lower.split('.').pop() : ''
    if (ext in FORMATS) return ext
    return MIME_TO_FORMAT[(mime || '').split(';')[0].trim()] ?? null
}
export const formatLabel = f => ({ epub: 'EPUB', pdf: 'PDF', mobi: 'MOBI', prc: 'MOBI', azw: 'AZW', azw3: 'AZW3', kf8: 'AZW3',
    fb2: 'FB2', fbz: 'FB2', cbz: 'CBZ', txt: 'TXT', md: 'Markdown', markdown: 'Markdown', html: 'HTML', htm: 'HTML', xhtml: 'HTML' }[f] ?? (f || '').toUpperCase())

let dbPromise = null
const open = () => dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('Database blocked'))
})

const tx = async (stores, mode, fn) => {
    const db = await open()
    return new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode)
        let result
        t.oncomplete = () => resolve(result)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error ?? new Error('Transaction aborted'))
        Promise.resolve(fn(t)).then(r => { result = r }, e => { reject(e); try { t.abort() } catch { /* ignore */ } })
    })
}
const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })

const uuid = () => crypto.randomUUID?.() ?? ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16))

export const library = {
    async all() { return tx('books', 'readonly', t => req(t.objectStore('books').getAll())) },
    async get(id) { return tx('books', 'readonly', t => req(t.objectStore('books').get(id))) },
    async put(book) { return tx('books', 'readwrite', t => req(t.objectStore('books').put(book))) },
    async getFile(id) {
        const v = await tx('files', 'readonly', t => req(t.objectStore('files').get(id)))
        return toBlob(v)
    },
    async remove(id) {
        return tx(['books', 'files'], 'readwrite', t => { t.objectStore('books').delete(id); t.objectStore('files').delete(id) })
    },
    async update(id, patch) {
        return tx('books', 'readwrite', async t => {
            const store = t.objectStore('books')
            const book = await req(store.get(id))
            if (!book) return null
            Object.assign(book, typeof patch === 'function' ? patch(book) : patch)
            store.put(book)
            return book
        })
    },
    async importFile(file, sourceUrl = null) {
        const format = detectFormat(file.name, file.type)
        if (!format) throw new Error(`Unsupported file: ${file.name}`)
        const id = uuid()
        const title = file.name.replace(/\.[^.]+$/, '').replace(/\.fb2$/i, '').replace(/_+/g, ' ').trim() || 'Untitled'
        const book = {
            id, title, author: '', format, fileName: file.name, size: file.size, addedAt: Date.now(), lastOpenedAt: 0,
            progress: 0, location: null, progressLabel: null, cover: null, metadataFetched: false, sourceUrl,
        }
        // Store raw bytes: Safari can return unusable Blobs from IndexedDB after the storing page is gone.
        const buf = await file.arrayBuffer()
        const record = { type: file.type || FORMATS[format], buf }
        await tx(['books', 'files'], 'readwrite', t => { t.objectStore('files').put(record, id); t.objectStore('books').put(book) })
        return book
    },
    async usage() {
        try { const e = await navigator.storage?.estimate?.(); return e ? { used: e.usage ?? 0, quota: e.quota ?? 0 } : null } catch { return null }
    },
    async persist() { try { return await navigator.storage?.persist?.() } catch { return false } },
}

/** Accepts a Blob, a { type, buf } record, or null and returns a Blob (or null). */
export const toBlob = v => {
    if (!v) return null
    if (v instanceof Blob) return v.size ? v : null
    if (v.buf) return new Blob([v.buf], { type: v.type || 'application/octet-stream' })
    return null
}

/** Converts a data: URL into a { type, buf } record safe to persist in IndexedDB. */
export const dataUrlToRecord = async dataUrl => {
    const res = await fetch(dataUrl)
    return { type: res.headers.get('content-type') || 'image/jpeg', buf: await res.arrayBuffer() }
}
