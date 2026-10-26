// IndexedDB-backed library used by the web (iPhone / browser) build.
// Two stores: `books` (metadata + cover blob) and `files` (the book file).

const DB_NAME = 'openshelf'
const DB_VERSION = 3

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
        if (!db.objectStoreNames.contains('highlights')) db.createObjectStore('highlights', { keyPath: 'id' }).createIndex('bookId', 'bookId')
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('bookId', 'bookId')
        if (!db.objectStoreNames.contains('vocab')) db.createObjectStore('vocab', { keyPath: 'id' }).createIndex('word', 'word')
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

export const uuid = () => crypto.randomUUID?.() ?? ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16))

export const highlights = {
    async list(bookId) { return tx('highlights', 'readonly', t => req(t.objectStore('highlights').index('bookId').getAll(bookId))) },
    async all() { return tx('highlights', 'readonly', t => req(t.objectStore('highlights').getAll())) },
    async put(h) { if (!h.id) h.id = uuid(); if (!h.createdAt) h.createdAt = Date.now(); await tx('highlights', 'readwrite', t => req(t.objectStore('highlights').put(h))); return h },
    async remove(id) { return tx('highlights', 'readwrite', t => req(t.objectStore('highlights').delete(id))) },
}

export const sessions = {
    async all() { return tx('sessions', 'readonly', t => req(t.objectStore('sessions').getAll())) },
    async forBook(bookId) { return tx('sessions', 'readonly', t => req(t.objectStore('sessions').index('bookId').getAll(bookId))) },
    async put(sess) { if (!sess.id) sess.id = uuid(); await tx('sessions', 'readwrite', t => req(t.objectStore('sessions').put(sess))); return sess },
}

/** Saved words (vocabulary). One record per saved word: { id, word, phonetic, pos, def, context, bookId, bookTitle, createdAt }. */
export const vocab = {
    async all() { return tx('vocab', 'readonly', t => req(t.objectStore('vocab').getAll())) },
    async find(word) { return tx('vocab', 'readonly', t => req(t.objectStore('vocab').index('word').get(word))) },
    async put(w) { if (!w.id) w.id = uuid(); if (!w.createdAt) w.createdAt = Date.now(); w.word = String(w.word || '').toLowerCase(); await tx('vocab', 'readwrite', t => req(t.objectStore('vocab').put(w))); return w },
    async remove(id) { return tx('vocab', 'readwrite', t => req(t.objectStore('vocab').delete(id))) },
}

/** Time spent in one book, from its sessions, plus a rough estimate of what is left at `fraction`. */
export const bookTime = (list, fraction = 0) => {
    let seconds = 0, covered = 0
    for (const s of list) {
        seconds += Math.max(0, Math.min(s.seconds || 0, 6 * 3600))
        if (s.fractionEnd != null && s.fractionStart != null) covered += Math.max(0, Math.min(1, s.fractionEnd - s.fractionStart))
    }
    // a pace needs a few minutes over a measurable stretch of the book
    const pace = seconds >= 300 && covered >= 0.01 ? seconds / covered : null
    const remaining = pace != null ? Math.max(0, (1 - Math.min(1, fraction)) * pace) : null
    return { seconds, remaining }
}

/** Reading statistics derived from sessions. Days are local-time calendar days. */
export const computeStats = (list, now = Date.now()) => {
    const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }
    const byDay = new Map()
    let total = 0
    for (const s of list) {
        const secs = Math.max(0, Math.min(s.seconds || 0, 6 * 3600))
        total += secs
        const k = dayKey(s.startedAt || s.endedAt || now)
        byDay.set(k, (byDay.get(k) || 0) + secs)
    }
    const today = byDay.get(dayKey(now)) || 0
    let week = 0
    for (let i = 0; i < 7; i++) week += byDay.get(dayKey(now - i * 86400000)) || 0
    // streak: consecutive days (ending today or yesterday) with at least 2 minutes
    let streak = 0
    const qualifies = ts => (byDay.get(dayKey(ts)) || 0) >= 120
    let cursor = qualifies(now) ? now : qualifies(now - 86400000) ? now - 86400000 : null
    while (cursor != null && qualifies(cursor)) { streak++; cursor -= 86400000 }
    const pagesToday = list.filter(s => dayKey(s.startedAt || now) === dayKey(now)).reduce((a, s) => a + (s.pages || 0), 0)
    // the last 7 days, oldest first, for the week strip
    const days = Array.from({ length: 7 }, (_, i) => { const ts = now - (6 - i) * 86400000; const seconds = byDay.get(dayKey(ts)) || 0; return { ts, seconds, read: seconds >= 120, today: i === 6 } })
    // best streak ever
    const readDays = [...byDay.entries()].filter(([, secs]) => secs >= 120).map(([k]) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m, d).getTime() }).sort((a, b) => a - b)
    let bestStreak = 0, run = 0, prev = null
    for (const ts of readDays) { run = prev != null && Math.round((ts - prev) / 86400000) === 1 ? run + 1 : 1; prev = ts; bestStreak = Math.max(bestStreak, run) }
    return { todaySeconds: today, weekSeconds: week, totalSeconds: total, streak, bestStreak: Math.max(bestStreak, streak), todayDone: today >= 120, days, pagesToday, sessions: list.length }
}

export const library = {
    async all() { return tx('books', 'readonly', t => req(t.objectStore('books').getAll())) },
    async get(id) { return tx('books', 'readonly', t => req(t.objectStore('books').get(id))) },
    async put(book) { return tx('books', 'readwrite', t => req(t.objectStore('books').put(book))) },
    async getFile(id) {
        const v = await tx('files', 'readonly', t => req(t.objectStore('files').get(id)))
        return toBlob(v)
    },
    async remove(id) {
        return tx(['books', 'files', 'highlights', 'sessions'], 'readwrite', async t => {
            t.objectStore('books').delete(id); t.objectStore('files').delete(id)
            for (const store of ['highlights', 'sessions']) {
                const keys = await req(t.objectStore(store).index('bookId').getAllKeys(id))
                for (const k of keys) t.objectStore(store).delete(k)
            }
        })
    },
    async putFileRecord(id, record) { return tx('files', 'readwrite', t => req(t.objectStore('files').put(record, id))) },
    async getFileRecord(id) { return tx('files', 'readonly', t => req(t.objectStore('files').get(id))) },
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
