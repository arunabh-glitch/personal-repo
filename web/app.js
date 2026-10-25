import { library, ACCEPT, formatLabel, detectFormat } from './reader/store.js'

const $ = s => document.querySelector(s)
const grid = $('#grid'), empty = $('#empty'), fileInput = $('#file-input')
const SORT_KEY = 'openshelf.sort'
let books = []
let sheetBook = null
const urls = new Map()

const toast = (msg, ms = 2500) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms) }
const busy = on => { let el = $('.progress-line'); if (on && !el) { el = document.createElement('div'); el.className = 'progress-line'; document.body.append(el) } else if (!on && el) el.remove() }
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'

const coverUrl = book => {
    if (!book.cover) return null
    if (!urls.has(book.id)) urls.set(book.id, URL.createObjectURL(book.cover))
    return urls.get(book.id)
}

const render = () => {
    const sort = localStorage.getItem(SORT_KEY) || 'recent'
    $('#sort').value = sort
    const list = [...books].sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title)
        : sort === 'author' ? (a.author || '￿').localeCompare(b.author || '￿') || a.title.localeCompare(b.title)
        : sort === 'added' ? b.addedAt - a.addedAt
        : Math.max(b.lastOpenedAt, b.addedAt) - Math.max(a.lastOpenedAt, a.addedAt))
    grid.textContent = ''
    for (const b of list) {
        const card = document.createElement('button')
        card.className = 'card'
        const pct = Math.round((b.progress || 0) * 100)
        const url = coverUrl(b)
        card.innerHTML = `<div class="cover">${url ? `<img alt="" src="${url}">` : `<div class="ph">${esc(b.title)}</div>`}
            <span class="badge">${pct > 0 ? pct + '%' : b.progress > 0 ? '<1%' : formatLabel(b.format)}</span>${b.progress > 0 ? `<div class="bar"><i style="width:${Math.max(1, pct)}%"></i></div>` : ''}</div>
            <div class="t">${esc(b.title)}</div><div class="a">${esc(b.author || formatLabel(b.format))}</div>`
        card.addEventListener('click', () => open(b))
        let timer
        const start = () => { timer = setTimeout(() => { timer = null; showSheet(b) }, 550) }
        const cancel = () => { if (timer) clearTimeout(timer) }
        card.addEventListener('touchstart', start, { passive: true })
        card.addEventListener('touchend', cancel); card.addEventListener('touchmove', cancel); card.addEventListener('touchcancel', cancel)
        card.addEventListener('contextmenu', e => { e.preventDefault(); showSheet(b) })
        grid.append(card)
    }
    empty.hidden = list.length > 0
    library.usage().then(u => { $('#storage').textContent = u && u.quota ? `${fmtSize(u.used)} used of ${fmtSize(u.quota)} available` : '' })
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const open = book => { location.href = `reader/index.html?id=${encodeURIComponent(book.id)}` }

const showSheet = book => {
    sheetBook = book
    $('#sheet-title').textContent = book.title
    $('#sheet-sub').textContent = [book.author, formatLabel(book.format), fmtSize(book.size)].filter(Boolean).join(' · ')
    $('#sheet').hidden = false; $('#sheet-scrim').hidden = false
    if (navigator.vibrate) navigator.vibrate(10)
}
const hideSheet = () => { $('#sheet').hidden = true; $('#sheet-scrim').hidden = true; sheetBook = null }
$('#sheet-scrim').addEventListener('click', hideSheet)
$('#sheet').addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act
    const b = sheetBook
    if (!act || !b) return
    if (act === 'open') open(b)
    else if (act === 'details') alert(`${b.title}\n${b.author || 'Unknown author'}\n${formatLabel(b.format)} · ${fmtSize(b.size)}\n${b.progressLabel || 'Not started'} (${Math.round((b.progress || 0) * 100)}%)\nAdded ${new Date(b.addedAt).toLocaleString()}${b.sourceUrl ? '\n' + b.sourceUrl : ''}`)
    else if (act === 'delete') {
        if (confirm(`Remove “${b.title}” from your library?`)) { await library.remove(b.id); urls.delete(b.id); await reload(); toast('Removed') }
    }
    hideSheet()
})

const reload = async () => { books = await library.all(); render() }

const importFiles = async files => {
    if (!files.length) return
    busy(true)
    let ok = 0, failed = []
    for (const f of files) {
        try { await library.importFile(f); ok++ } catch (e) { console.error(e); failed.push(f.name) }
    }
    busy(false)
    await reload()
    if (failed.length) toast(`Could not add: ${failed.join(', ')}`, 4000)
    else toast(ok === 1 ? 'Added 1 book' : `Added ${ok} books`)
    if (ok) library.persist()
}

fileInput.accept = ACCEPT
fileInput.addEventListener('change', () => { importFiles([...fileInput.files]); fileInput.value = '' })
$('#fab').addEventListener('click', () => fileInput.click())
$('#sort').addEventListener('change', e => { localStorage.setItem(SORT_KEY, e.target.value); render() })
$('#btn-url').addEventListener('click', async () => {
    const url = prompt('Direct link to an EPUB, PDF or other book file:')
    if (!url) return
    busy(true)
    try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        let name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'book')
        const cd = res.headers.get('content-disposition')
        const m = cd && (/filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd))
        if (m) name = decodeURIComponent(m[1])
        if (!detectFormat(name, blob.type)) throw new Error('Unsupported file type')
        await library.importFile(new File([blob], name, { type: blob.type }), url)
        await reload(); toast('Added'); library.persist()
    } catch (e) {
        console.error(e)
        toast(e.name === 'TypeError' ? 'That site does not allow downloads from web apps. Download the file in Safari, then add it from Files.' : `Download failed: ${e.message}`, 5000)
    } finally { busy(false) }
})

// Drag & drop on desktop
document.addEventListener('dragover', e => e.preventDefault())
document.addEventListener('drop', e => { e.preventDefault(); importFiles([...e.dataTransfer.files]) })

// iOS "Add to Home Screen" hint
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
if (isIOS && !standalone && !localStorage.getItem('openshelf.hint')) $('#install-hint').hidden = false
$('#hint-close').addEventListener('click', () => { $('#install-hint').hidden = true; localStorage.setItem('openshelf.hint', '1') })

// Offline support
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e))
window.addEventListener('pageshow', e => { if (e.persisted) reload() })
document.addEventListener('visibilitychange', () => { if (!document.hidden) reload() })

reload().catch(e => { console.error(e); toast('Storage unavailable: ' + e.message, 6000) })
