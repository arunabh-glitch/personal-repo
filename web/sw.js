// Offline cache for OpenShelf. The precache list and version are filled in by build.mjs.
const VERSION = '__VERSION__'
const CACHE = 'openshelf-' + VERSION
const PRECACHE = __PRECACHE__

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', e => {
    const url = new URL(e.request.url)
    if (e.request.method !== 'GET' || url.origin !== location.origin) return
    e.respondWith((async () => {
        const cache = await caches.open(CACHE)
        const key = new Request(url.origin + url.pathname) // ignore query strings (reader/index.html?id=…)
        const hit = await cache.match(key)
        if (hit) return hit
        try {
            const res = await fetch(e.request)
            if (res.ok && res.type === 'basic') cache.put(key, res.clone())
            return res
        } catch (err) {
            if (e.request.mode === 'navigate') return (await cache.match(new Request(new URL('./index.html', self.registration.scope).href))) || (await cache.match(key)) || Response.error()
            throw err
        }
    })())
})
