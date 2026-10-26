// Host bridge for the web build (iPhone home-screen app / any browser).
// Mirrors the Android `window.Android` interface on top of IndexedDB.
import { library, highlights, sessions, vocab, dataUrlToRecord } from './store.js'

const SETTINGS_KEY = 'openshelf.reader.settings'

export const createWebBridge = async id => {
    const book = await library.get(id)
    if (!book) throw new Error('This book is no longer in the library.')
    const file = await library.getFile(id)
    if (!file) throw new Error('The book file is missing from storage. Remove it from the shelf and add it again.')
    const url = URL.createObjectURL(file)
    let wakeLock = null
    await library.update(id, { lastOpenedAt: Date.now() })

    return {
        getBookInfo: () => JSON.stringify({
            id: book.id, title: book.title, author: book.author, format: book.format, fileName: book.fileName,
            url, location: book.location, fraction: book.progress, needsMetadata: !book.metadataFetched,
        }),
        getSettings: () => localStorage.getItem(SETTINGS_KEY) ?? '{}',
        saveSettings: json => localStorage.setItem(SETTINGS_KEY, json),
        saveProgress: json => {
            const p = JSON.parse(json)
            library.update(id, { location: p.location ?? null, progress: p.fraction ?? 0, progressLabel: p.label ?? null, lastOpenedAt: Date.now() }).catch(console.error)
        },
        onMetadata: async json => {
            const m = JSON.parse(json)
            const patch = { metadataFetched: true }
            if (m.title) patch.title = m.title
            if (m.author) patch.author = m.author
            if (m.cover) { try { patch.cover = await dataUrlToRecord(m.cover) } catch (e) { console.warn(e) } }
            library.update(id, patch).catch(console.error)
        },
        onReady: () => {},
        onError: msg => console.error(msg),
        close: () => {
            URL.revokeObjectURL(url)
            // Inside the installed app there is no browser chrome; go back to the library explicitly.
            if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) history.back()
            else location.href = new URL('../index.html', location.href).href
        },
        setBarsVisible: () => {},
        keepScreenOn: async on => {
            try {
                if (on && !wakeLock && navigator.wakeLock) {
                    wakeLock = await navigator.wakeLock.request('screen')
                    wakeLock.addEventListener('release', () => { wakeLock = null })
                } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null }
            } catch (e) { console.warn('wake lock', e) }
        },
        openExternal: href => window.open(href, '_blank', 'noopener'),
        // highlights & notes
        listHighlights: async () => JSON.stringify(await highlights.list(id)),
        saveHighlight: async json => { const h = JSON.parse(json); h.bookId = id; return (await highlights.put(h)).id },
        deleteHighlight: hid => highlights.remove(hid),
        // reading sessions
        saveSession: json => { const s = JSON.parse(json); s.bookId = id; return sessions.put(s) },
        markFinished: () => library.update(id, { finishedAt: Date.now() }).catch(console.error),
        listSessions: async () => JSON.stringify(await sessions.forBook(id)),
        // vocabulary
        listWords: async () => JSON.stringify(await vocab.all()),
        saveWord: async json => { const w = JSON.parse(json); w.bookId = id; w.bookTitle ||= book.title; return (await vocab.put(w)).id },
        deleteWord: wid => vocab.remove(wid),
    }
}
