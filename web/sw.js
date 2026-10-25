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
self.addEventListener('fetch', e => {
    const url = new URL(e.request.url)
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
