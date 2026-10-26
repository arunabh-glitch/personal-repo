// Backup & restore: one .zip with the shelf index, every book file, covers, highlights, sessions and saved words.
// Used to move a shelf between devices (via Files / iCloud Drive / any file transfer).
import { library, highlights, sessions, vocab, toBlob } from './store.js'

const SETTINGS_KEYS = ['dogear.reader.settings', 'dogear.sort', 'dogear.dict.v1']

export const createBackup = async (onProgress = () => {}) => {
    const { ZipWriter } = await import('./zipwrite.js')
    const writer = new ZipWriter()
    const books = await library.all()
    const manifest = {
        app: 'dogear', version: 2, createdAt: Date.now(),
        books: books.map(b => ({ ...b, cover: undefined, coverFile: b.cover ? `covers/${b.id}.jpg` : null, file: `books/${b.id}` })),
        highlights: await highlights.all(),
        sessions: await sessions.all(),
        vocab: await vocab.all(),
        settings: Object.fromEntries(SETTINGS_KEYS.map(k => [k, localStorage.getItem(k)]).filter(([, v]) => v != null)),
    }
    await writer.add('dogear.json', JSON.stringify(manifest))
    let i = 0
    for (const b of books) {
        const file = await library.getFile(b.id)
        if (file) await writer.add(`books/${b.id}`, file)
        const cover = toBlob(b.cover)
        if (cover) await writer.add(`covers/${b.id}.jpg`, cover)
        onProgress(++i, books.length)
    }
    return writer.close()
}

/** Restores a backup. Existing books (same id) keep their newer progress; everything else is added. */
export const restoreBackup = async (blob, onProgress = () => {}) => {
    const { ZipReader, BlobReader, BlobWriter, TextWriter, configure } = await import('./foliate/vendor/zip.js')
    configure({ useWebWorkers: false })
    const reader = new ZipReader(new BlobReader(blob))
    const entries = await reader.getEntries()
    const byName = new Map(entries.map(e => [e.filename, e]))
    const manifestEntry = byName.get('dogear.json')
    if (!manifestEntry) throw new Error('Not a Lumi backup')
    const manifest = JSON.parse(await manifestEntry.getData(new TextWriter()))
    if (manifest.app !== 'dogear') throw new Error('Not a Lumi backup')
    const existing = new Map((await library.all()).map(b => [b.id, b]))
    let added = 0, updated = 0, i = 0
    for (const b of manifest.books) {
        const have = existing.get(b.id)
        const record = { ...b }; delete record.coverFile; delete record.file
        const coverEntry = b.coverFile && byName.get(b.coverFile)
        if (coverEntry) record.cover = { type: 'image/jpeg', buf: await (await coverEntry.getData(new BlobWriter('image/jpeg'))).arrayBuffer() }
        if (have) {
            // keep whichever side read further / more recently
            if ((have.lastOpenedAt || 0) >= (b.lastOpenedAt || 0)) { record.progress = have.progress; record.location = have.location; record.progressLabel = have.progressLabel; record.lastOpenedAt = have.lastOpenedAt }
            if (!record.cover && have.cover) record.cover = have.cover
            record.tags = [...new Set([...(have.tags || []), ...(b.tags || [])])]
            updated++
        } else {
            const fileEntry = byName.get(b.file)
            if (!fileEntry) continue
            const fileBlob = await fileEntry.getData(new BlobWriter('application/octet-stream'))
            await library.putFileRecord(b.id, { type: fileBlob.type, buf: await fileBlob.arrayBuffer() })
            added++
        }
        await library.put(record)
        onProgress(++i, manifest.books.length)
    }
    const haveH = new Set((await highlights.all()).map(h => h.id))
    for (const h of manifest.highlights || []) if (!haveH.has(h.id)) await highlights.put(h)
    const haveS = new Set((await sessions.all()).map(s => s.id))
    for (const s of manifest.sessions || []) if (!haveS.has(s.id)) await sessions.put(s)
    const haveW = new Set((await vocab.all()).map(w => w.id))
    for (const w of manifest.vocab || []) if (!haveW.has(w.id)) await vocab.put(w)
    for (const [k, v] of Object.entries(manifest.settings || {})) if (localStorage.getItem(k) == null) localStorage.setItem(k, v)
    await reader.close()
    return { added, updated, highlights: (manifest.highlights || []).length }
}
