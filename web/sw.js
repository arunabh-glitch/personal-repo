// Offline cache for Dogear. The precache list and version are filled in by build.mjs.
//
// Strategy: the small "app shell" (HTML, CSS, JS) is network-first so an update is
// never served half old / half new; heavy, versioned libraries (foliate, pdf.js,
// fonts, icons) are cache-first. Everything falls back to the cache offline.
const VERSION = '__VERSION__'
const CACHE = 'dogear-' + VERSION
const PRECACHE = __PRECACHE__
const SHELL_TIMEOUT_MS = 4000

const scopePath = new URL(self.registration.scope).pathname
const isShell = pathname => {
    const rel = pathname.startsWith(scopePath) ? pathname.slice(scopePath.length) : pathname
    if (rel.startsWith('reader/foliate/') || rel.startsWith('reader/pdfjs/') || rel.startsWith('reader/fonts/') || rel.startsWith('icons/')) return false
    return /\.(html|css|js|webmanifest)$/.test(rel) || rel === '' || rel.endsWith('/')
}
const keyFor = url => {
    let p = url.pathname
    if (p.endsWith('/')) p += 'index.html'
    return new Request(url.origin + p)
}

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})
// Web Share Target (Android): files shared to Dogear are stored straight into the shelf.
const FORMATS = { epub: 'application/epub+zip', pdf: 'application/pdf', mobi: 'application/x-mobipocket-ebook', azw: 'application/x-mobipocket-ebook', azw3: 'application/vnd.amazon.mobi8-ebook', kf8: 'application/vnd.amazon.mobi8-ebook', prc: 'application/x-mobipocket-ebook', fb2: 'application/x-fictionbook+xml', fbz: 'application/x-zip-compressed-fb2', cbz: 'application/vnd.comicbook+zip', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml' }
const openDB = () => new Promise((resolve, reject) => {
    const r = indexedDB.open('dogear-db-probe-unused', 1); r.onsuccess = () => { r.result.close(); indexedDB.deleteDatabase('dogear-db-probe-unused'); resolve() }; r.onerror = () => resolve()
})
const storeShared = async files => {
    await openDB()
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('openshelf', 3); r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' }); if (!d.objectStoreNames.contains('files')) d.createObjectStore('files'); if (!d.objectStoreNames.contains('highlights')) d.createObjectStore('highlights', { keyPath: 'id' }).createIndex('bookId', 'bookId'); if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' }).createIndex('bookId', 'bookId'); if (!d.objectStoreNames.contains('vocab')) d.createObjectStore('vocab', { keyPath: 'id' }).createIndex('word', 'word') }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    let n = 0
    for (const f of files) {
        const lower = (f.name || '').toLowerCase(); const ext = lower.endsWith('.fb2.zip') ? 'fbz' : lower.split('.').pop()
        if (!(ext in FORMATS)) continue
        const id = crypto.randomUUID()
        const book = { id, title: f.name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || 'Untitled', author: '', format: ext, fileName: f.name, size: f.size, addedAt: Date.now(), lastOpenedAt: 0, progress: 0, location: null, progressLabel: null, cover: null, metadataFetched: false, sourceUrl: null, tags: [] }
        const buf = await f.arrayBuffer()
        await new Promise((resolve, reject) => { const t = db.transaction(['books', 'files'], 'readwrite'); t.objectStore('files').put({ type: f.type || FORMATS[ext], buf }, id); t.objectStore('books').put(book); t.oncomplete = resolve; t.onerror = () => reject(t.error) })
        n++
    }
    db.close()
    return n
}

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url)
    if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share')) {
        e.respondWith((async () => {
            let n = 0
            try { const fd = await e.request.formData(); n = await storeShared(fd.getAll('books').filter(f => f && f.size)) } catch (err) { console.error('share target', err) }
            return Response.redirect(new URL(`./index.html?shared=${n}`, self.registration.scope).href, 303)
        })())
        return
    }
    if (e.request.method !== 'GET' || url.origin !== location.origin) return
    const key = keyFor(url)
    e.respondWith((async () => {
        const cache = await caches.open(CACHE)
        if (isShell(url.pathname)) {
            try {
                const ctrl = new AbortController()
                const timer = setTimeout(() => ctrl.abort(), SHELL_TIMEOUT_MS)
                const res = await fetch(e.request, { signal: ctrl.signal, cache: 'no-cache' })
                clearTimeout(timer)
                if (res.ok && res.type === 'basic') cache.put(key, res.clone())
                return res
            } catch {
                const hit = await cache.match(key)
                if (hit) return hit
                if (e.request.mode === 'navigate') return (await cache.match(new Request(new URL('./index.html', self.registration.scope).href))) || Response.error()
                return Response.error()
            }
        }
        const hit = await cache.match(key)
        if (hit) return hit
        const res = await fetch(e.request)
        if (res.ok && res.type === 'basic') cache.put(key, res.clone())
        return res
    })())
})
