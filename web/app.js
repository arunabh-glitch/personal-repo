import { library, sessions, highlights, vocab, computeStats, bookTime, ACCEPT, formatLabel, detectFormat, toBlob } from './reader/store.js'

const $ = s => document.querySelector(s)
const $$ = s => Array.from(document.querySelectorAll(s))
const grid = $('#grid'), empty = $('#empty'), fileInput = $('#file-input')
const SORT_KEY = 'dogear.sort'
let books = []
let allSessions = []
let words = []
let sheetBook = null
let activeTag = null
let query = ''
const isFinished = b => !!b.finishedAt || (b.progress || 0) >= 0.985
const urls = new Map()

const toast = (msg, ms = 2500) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms) }
const busy = on => { let el = $('.progress-line'); if (on && !el) { el = document.createElement('div'); el.className = 'progress-line'; document.body.append(el) } else if (!on && el) el.remove() }
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const coverUrl = book => {
    const blob = toBlob(book.cover)
    if (!blob) return null
    if (!urls.has(book.id)) urls.set(book.id, URL.createObjectURL(blob))
    return urls.get(book.id)
}
// A cover that fails to load is discarded so the reader regenerates it on the next open.
const healCover = book => library.update(book.id, { cover: null, metadataFetched: false }).catch(() => {})
const pctOf = b => Math.round((b.progress || 0) * 100)
const fmtMin = secs => { const m = Math.round(secs / 60); return m >= 60 ? (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`) : `${m}m` }
const fmtLeft = secs => { const m = Math.round(secs / 60); if (m < 1) return 'a minute'; if (m < 60) return `${m} min`; const h = Math.floor(m / 60), r = m % 60; return r ? `${h}h ${r}m` : `${h}h` }
const timeFor = b => bookTime(allSessions.filter(s => s.bookId === b.id), b.progress || 0)
const timeLine = b => { const t = timeFor(b); return t.seconds < 60 ? '' : `${fmtMin(t.seconds)} read` + (t.remaining != null && !isFinished(b) ? ` · ~${fmtLeft(t.remaining)} left` : '') }
const badgeFor = b => { const p = pctOf(b); return p >= 100 ? 'done' : p > 0 ? p + '%' : b.progress > 0 ? 'just started' : formatLabel(b.format) }


const render = () => {
    for (const u of urls.values()) URL.revokeObjectURL(u)
    urls.clear()
    const sort = localStorage.getItem(SORT_KEY) || 'recent'
    $('#sort').value = sort
    const q = query.trim().toLowerCase()
    const matches = b => (!activeTag || (b.tags || []).includes(activeTag)) && (!q || `${b.title} ${b.author} ${(b.tags || []).join(' ')}`.toLowerCase().includes(q))
    const list = books.filter(b => !isFinished(b) && matches(b)).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title)
        : sort === 'author' ? (a.author || '￿').localeCompare(b.author || '￿') || a.title.localeCompare(b.title)
        : sort === 'added' ? b.addedAt - a.addedAt
        : Math.max(b.lastOpenedAt, b.addedAt) - Math.max(a.lastOpenedAt, a.addedAt))

    // Continue reading: most recently opened, unfinished book.
    const current = [...books].filter(b => b.lastOpenedAt && !isFinished(b)).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0]
    $('#continue').hidden = !current
    if (current) {
        const url = coverUrl(current)
        $('#cc-img').hidden = !url; if (url) $('#cc-img').src = url
        $('#cc-ph').hidden = !!url
        $('#cc-ph').textContent = current.title
        $('#cc-img').onerror = () => { $('#cc-img').hidden = true; $('#cc-ph').hidden = false; healCover(current) }
        $('#cc-title').textContent = current.title
        $('#cc-author').textContent = current.author || formatLabel(current.format)
        $('#cc-where').textContent = current.progressLabel ? `${current.progressLabel} · ${pctOf(current)}%` : (current.progress > 0 ? `${pctOf(current)}% in` : 'just started')
        const tl = timeLine(current); $('#cc-time').hidden = !tl; $('#cc-time').textContent = tl
        $('#cc-bar').style.width = Math.max(1, pctOf(current)) + '%'
        $('#continue-card').onclick = () => open(current)
    }

    $('#shelf-head').hidden = !books.length
    const tags = [...new Set(books.flatMap(b => b.tags || []))].sort()
    const chips = $('#tag-chips'); chips.textContent = ''
    if (tags.length) for (const t of [null, ...tags]) {
        const c = document.createElement('button'); c.className = 'tag-chip' + (activeTag === t ? ' active' : ''); c.textContent = t ?? 'all'
        c.addEventListener('click', () => { activeTag = t; render() }); chips.append(c)
    }
    const done = books.filter(b => isFinished(b) && matches(b)).sort((a, b) => (b.finishedAt || b.lastOpenedAt || 0) - (a.finishedAt || a.lastOpenedAt || 0))
    $('#finished-sec').hidden = !done.length
    const fg = $('#finished-grid'); fg.textContent = ''
    for (const b of done) fg.append(makeCard(b))
    renderStats()

    grid.textContent = ''
    if (!list.length && books.length) { const d = document.createElement('p'); d.className = 'muted'; d.textContent = q || activeTag ? 'nothing matches.' : 'everything here is finished'; grid.append(d) }
    for (const b of list) grid.append(makeCard(b))
    empty.hidden = books.length > 0
    library.usage().then(u => { $('#storage').textContent = books.length && u && u.quota ? `${fmtSize(u.used)} of books · ${fmtSize(u.quota - u.used)} free` : '' })
}

const renderStats = () => {
    const st = computeStats(allSessions)
    const finished = books.filter(isFinished).length
    const show = books.length > 0 && (st.sessions > 0 || finished > 0 || words.length > 0)
    $('#stats').hidden = !show
    if (!show) return
    $('#st-today').textContent = fmtMin(st.todaySeconds)
    $('#st-week').textContent = fmtMin(st.weekSeconds)
    $('#st-total').textContent = fmtMin(st.totalSeconds)
    $('#st-words-n').textContent = String(words.length)
    $('#st-words').querySelector('span').textContent = words.length === 1 ? 'word saved' : 'words saved'
    // streak card
    $('#st-streak').textContent = String(st.streak)
    $('#st-streak-label').textContent = st.streak === 1 ? 'day streak' : 'day streak'
    $('#st-best').textContent = String(st.bestStreak)
    const flame = $('.flame'); flame.classList.toggle('lit', st.todayDone); flame.classList.toggle('cold', !st.todayDone && st.streak === 0)
    $('#st-days').innerHTML = st.days.map(d => `<i class="day${d.read ? ' read' : ''}${d.today ? ' today' : ''}" title="${'SMTWTFS'[new Date(d.ts).getDay()]} · ${fmtMin(d.seconds)}"></i>`).join('')
    $('#st-nudge').textContent = st.todayDone
        ? (st.streak >= 2 ? `${st.streak} days in a row. keep it rolling.` : 'today’s reading is in. nice.')
        : st.streak > 0 ? 'two minutes today keeps the streak alive.' : 'read for two minutes today to start a streak.'
    const stickers = []
    if (st.streak >= 30) stickers.push(['pink', '30-day streak'])
    else if (st.streak >= 7) stickers.push(['pink', 'week streak'])
    else if (st.streak >= 3) stickers.push(['sun', '3-day streak'])
    if (st.todaySeconds >= 1800) stickers.push(['lime', '30 min today'])
    else if (st.todaySeconds >= 600) stickers.push(['lime', '10 min today'])
    if (finished >= 10) stickers.push(['blue', `${finished} books finished`])
    else if (finished >= 1) stickers.push(['blue', finished === 1 ? 'first finish' : `${finished} finished`])
    if (st.totalSeconds >= 36000) stickers.push(['lilac', '10 hours read'])
    if (st.pagesToday >= 50) stickers.push(['lilac', `${st.pagesToday} pages today`])
    if (words.length >= 50) stickers.push(['sun', `${words.length} words`])
    else if (words.length >= 10) stickers.push(['sun', 'word collector'])
    $('#st-stickers').innerHTML = stickers.map(([c, t]) => `<span class="${c}">${t}</span>`).join('')
}

const makeCard = b => {
    {
        const card = document.createElement('button')
        const pct = pctOf(b)
        card.className = 'card' + (b.progress > 0 ? ' started' : '') + (pct >= 100 ? ' done' : '')
        const url = coverUrl(b)
        card.innerHTML = `<div class="cover">${url ? `<img alt="" src="${url}">` : `<div class="ph"><span>${esc(b.title)}</span>${b.author ? `<small>${esc(b.author)}</small>` : ''}</div>`}
            <i class="ear" aria-hidden="true"></i><span class="badge">${badgeFor(b)}</span>${b.progress > 0 ? `<div class="bar"><i style="width:${Math.max(1, pct)}%"></i></div>` : ''}</div>
            <div class="t">${esc(b.title)}</div><div class="a">${esc(b.author || formatLabel(b.format))}</div>${(b.tags || []).length ? `<div class="tags">${b.tags.map(t => `<i>${esc(t)}</i>`).join('')}</div>` : ''}`
        card.querySelector('img')?.addEventListener('error', e => {
            e.target.outerHTML = `<div class="ph"><span>${esc(b.title)}</span>${b.author ? `<small>${esc(b.author)}</small>` : ''}</div>`
            healCover(b)
        })
        card.addEventListener('click', () => open(b))
        let timer
        const start = () => { timer = setTimeout(() => { timer = null; showSheet(b) }, 550) }
        const cancel = () => { if (timer) clearTimeout(timer) }
        card.addEventListener('touchstart', start, { passive: true })
        card.addEventListener('touchend', cancel); card.addEventListener('touchmove', cancel); card.addEventListener('touchcancel', cancel)
        card.addEventListener('contextmenu', e => { e.preventDefault(); showSheet(b) })
        return card
    }
}

const open = book => { location.href = `reader/index.html?id=${encodeURIComponent(book.id)}` }

const showSheet = book => {
    sheetBook = book
    $('#sheet-title').textContent = book.title
    const tb = timeFor(book)
    $('#sheet-sub').textContent = [book.author, formatLabel(book.format), fmtSize(book.size), book.progressLabel, tb.seconds >= 60 ? `${fmtMin(tb.seconds)} read` : null].filter(Boolean).join(' · ')
    $('#sheet [data-act="finished"]').textContent = isFinished(book) ? 'move back to the shelf' : 'mark as finished'
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
    else if (act === 'tags') {
        const v = prompt('tags, comma separated (e.g. sci-fi, to read):', (b.tags || []).join(', '))
        if (v !== null) { const tags = [...new Set(v.split(',').map(t => t.trim().toLowerCase()).filter(Boolean))]; await library.update(b.id, { tags }); await reload(); toast(tags.length ? 'tagged ✓' : 'tags cleared') }
    }
    else if (act === 'finished') { await library.update(b.id, isFinished(b) ? { finishedAt: null, progress: Math.min(b.progress || 0, 0.97) } : { finishedAt: Date.now() }); await reload(); toast(isFinished(b) ? 'back on the shelf' : 'finished!'); if (!isFinished(b)) mascot.act('excited') }
    else if (act === 'details') alert(`${b.title}\n${b.author || 'Unknown author'}\n${formatLabel(b.format)} · ${fmtSize(b.size)}\n${b.progressLabel || 'Not started'} (${pctOf(b)}%)\n${timeLine(b) || 'No reading time yet'}\nAdded ${new Date(b.addedAt).toLocaleString()}${b.sourceUrl ? '\n' + b.sourceUrl : ''}`)
    else if (act === 'delete') {
        if (confirm(`remove “${b.title}” from your shelf?`)) { await library.remove(b.id); urls.delete(b.id); await reload(); toast('gone') }
    }
    hideSheet()
})

// ---- the header mascot's idle life: one small act every few seconds, naps when you've been away ----
const mascotLife = () => {
    const m = $('.top .mascot')
    if (!m || matchMedia('(prefers-reduced-motion: reduce)').matches) return { act: () => {} }
    const ACTS = [['blink', 320, 6], ['dblblink', 600, 2], ['look-left', 1100, 2], ['look-right', 1100, 2], ['look-up', 900, 1], ['happy', 1500, 2], ['wink', 600, 1], ['surprised', 1000, 1], ['flap', 900, 3], ['wiggle', 700, 1], ['bounce', 700, 1]]
    let busy = null, lastTouch = Date.now(), asleep = false
    const clear = () => { if (busy) { clearTimeout(busy.t); m.classList.remove('is-' + busy.name); busy = null } }
    const act = (name, ms, force = false) => {
        if (busy && !force) return
        if (force) clear()
        if (asleep) wake()
        m.classList.add('is-' + name)
        busy = { name, t: setTimeout(() => { m.classList.remove('is-' + name); busy = null }, ms) }
    }
    const pick = () => { let r = Math.random() * ACTS.reduce((a, x) => a + x[2], 0); return ACTS.find(x => (r -= x[2]) < 0) || ACTS[0] }
    const nap = () => { asleep = true; m.classList.add('is-sleepy') }
    const wake = () => { if (!asleep) return; asleep = false; m.classList.remove('is-sleepy'); act('surprised', 900, true) }
    const tick = () => {
        if (document.visibilityState === 'visible') {
            if (!asleep && Date.now() - lastTouch > 60000) nap()
            else if (!asleep) { const [name, ms] = pick(); act(name, ms) }
        }
        setTimeout(tick, 1800 + Math.random() * 3400)
    }
    setTimeout(tick, 1500)
    document.addEventListener('pointerdown', () => { lastTouch = Date.now(); if (asleep) wake() }, { passive: true })
    m.addEventListener('click', () => act(Math.random() < 0.25 ? 'wink' : 'excited', 1200, true))
    return { act: (name = 'excited', ms = 1200) => act(name, ms, true) }
}
const mascot = mascotLife()
// size the page to the visible viewport (Android browsers can report dynamic viewport units taller than what is visible)
const fitViewport = () => { const h = window.visualViewport?.height || window.innerHeight; if (h > 200) document.documentElement.style.setProperty('--vvh', Math.round(h) + 'px') }
fitViewport(); window.visualViewport?.addEventListener('resize', fitViewport); window.addEventListener('resize', fitViewport)
// no pinch zoom on the shelf (iOS ignores the viewport meta; the gesture events are what it honours)
for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, e => e.preventDefault())

const reload = async () => { books = await library.all(); allSessions = await sessions.all().catch(() => []); words = await vocab.all().catch(() => []); render() }

const importFiles = async files => {
    if (!files.length) return
    busy(true)
    let ok = 0, failed = []
    for (const f of files) {
        try { await library.importFile(f); ok++ } catch (e) { console.error(e); failed.push(f.name) }
    }
    busy(false)
    await reload()
    if (failed.length) toast(`couldn’t add: ${failed.join(', ')}`, 4000)
    else { toast(ok === 1 ? 'on the shelf' : `${ok} books on the shelf`); mascot.act('excited') }
    if (ok) library.persist()
}

fileInput.accept = ACCEPT
fileInput.addEventListener('change', () => { importFiles([...fileInput.files]); fileInput.value = '' })
$('#fab').addEventListener('click', () => fileInput.click())
$('#sort').addEventListener('change', e => { localStorage.setItem(SORT_KEY, e.target.value); render() })
$('#search').addEventListener('input', e => { query = e.target.value; render() })
const showMore = () => { $('#more').hidden = false; $('#sheet-scrim').hidden = false }
const hideMore = () => { $('#more').hidden = true; if ($('#sheet').hidden) $('#sheet-scrim').hidden = true }
$('#btn-more').addEventListener('click', showMore)
$('#sheet-scrim').addEventListener('click', hideMore)
$('#more').addEventListener('click', e => {
    const act = e.target.closest('[data-more]')?.dataset.more
    hideMore()
    if (act === 'find') openFind()
    else if (act === 'url') addFromUrl()
    else if (act === 'backup') backup()
    else if (act === 'restore') $('#restore-input').click()
    else if (act === 'words') openWords()
    else if (act === 'help') { $('#help').hidden = false }
})

// ---- my words (vocabulary) ----
const escRe = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const markWord = (ctx, word) => { const re = new RegExp(`(${escRe(word)}\\w*)`, 'i'); return esc(ctx).replace(re, '<mark>$1</mark>') }
const openWords = async () => {
    words = await vocab.all().catch(() => [])
    renderWords()
    $('#quiz').hidden = true; $('#words-list').hidden = false
    $('#words').hidden = false
}
const renderWords = () => {
    const list = [...words].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    $('#words-count').textContent = list.length ? `${list.length} ${list.length === 1 ? 'word' : 'words'}, newest first` : ''
    $('#words-empty').hidden = list.length > 0
    $('#quiz-start').hidden = list.length < 1
    $('#words-list').innerHTML = list.map(w => `<article class="word-card" data-id="${esc(w.id)}">
        <div class="wc-head"><h3 class="wc-word">${esc(w.word)}</h3>${w.phonetic ? `<span class="wc-phon">${esc(w.phonetic)}</span>` : ''}<span class="spacer"></span>
            <button class="icon-sm" data-wact="speak" aria-label="Pronounce"><svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg></button>
            <button class="icon-sm" data-wact="remove" aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button></div>
        ${w.pos ? `<span class="wc-pos">${esc(w.pos)}</span>` : ''}
        <p class="wc-def">${esc(w.def || '')}</p>
        ${w.context && w.context.toLowerCase() !== w.word ? `<blockquote class="wc-ctx">“${markWord(w.context, w.word)}”${w.bookTitle ? `<cite>${esc(w.bookTitle)}</cite>` : ''}</blockquote>` : w.bookTitle ? `<p class="wc-from">from <cite>${esc(w.bookTitle)}</cite></p>` : ''}
    </article>`).join('')
}
$('#words-list').addEventListener('click', async e => {
    const btn = e.target.closest('[data-wact]'); if (!btn) return
    const id = btn.closest('.word-card').dataset.id, w = words.find(x => x.id === id)
    if (!w) return
    if (btn.dataset.wact === 'speak' && 'speechSynthesis' in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(w.word)) }
    if (btn.dataset.wact === 'remove') { await vocab.remove(id); words = words.filter(x => x.id !== id); renderWords(); renderStats(); toast('removed') }
})
$('#words-close').addEventListener('click', () => { $('#words').hidden = true; renderStats() })
$('#stats-strip').addEventListener('click', () => { const more = $('#stats-more'); more.hidden = !more.hidden; $('#stats-strip').setAttribute('aria-expanded', String(!more.hidden)) })
$('#st-words').addEventListener('click', () => openWords())

// flashcards
let quiz = null
const startQuiz = () => {
    const pool = [...words].sort(() => Math.random() - 0.5).slice(0, 20)
    quiz = { queue: pool, again: [], missed: new Set(), firstTry: 0, total: pool.length, current: null }
    $('#words-list').hidden = true; $('#words-empty').hidden = true; $('#quiz-start').hidden = true
    $('#quiz').hidden = false; $('#quiz-done').hidden = true; $('#quiz-card').hidden = false
    nextCard()
}
const nextCard = () => {
    if (!quiz.queue.length) { if (quiz.again.length) { quiz.queue = quiz.again; quiz.again = [] } else return finishQuiz() }
    const w = quiz.current = quiz.queue[0]
    const done = quiz.total - quiz.queue.length - quiz.again.length
    $('#quiz-progress').textContent = `${done} / ${quiz.total}`
    $('#quiz-word').textContent = w.word
    $('#quiz-ctx').textContent = w.context && w.context.toLowerCase() !== w.word ? w.context.replace(new RegExp(escRe(w.word) + '\\w*', 'i'), '____') : ''
    $('#quiz-def').textContent = [w.pos, w.def].filter(Boolean).join(' · ')
    $('#quiz-def').hidden = true; $('#quiz-hint').hidden = false; $('#quiz-answers').hidden = true
}
const finishQuiz = () => {
    $('#quiz-card').hidden = true; $('#quiz-answers').hidden = true; $('#quiz-done').hidden = false
    $('#quiz-score').textContent = `${quiz.firstTry} / ${quiz.total}`
    const r = quiz.total ? quiz.firstTry / quiz.total : 0
    $('#quiz-msg').textContent = r === 1 ? 'flawless. go read something harder.' : r >= 0.7 ? 'solid. the rest will stick next time.' : 'they’ll stick. come back tomorrow.'
    $('#quiz-progress').textContent = `${quiz.total} / ${quiz.total}`
}
const endQuiz = () => { quiz = null; $('#quiz').hidden = true; renderWords(); $('#words-list').hidden = false }
$('#quiz-start').addEventListener('click', startQuiz)
$('#quiz-card').addEventListener('click', () => { if (!quiz || !$('#quiz-def').hidden) return; $('#quiz-def').hidden = false; $('#quiz-hint').hidden = true; $('#quiz-answers').hidden = false })
$('#quiz-got').addEventListener('click', () => { const w = quiz.queue.shift(); if (!quiz.missed.has(w.id)) quiz.firstTry++; nextCard() })
$('#quiz-again').addEventListener('click', () => { const w = quiz.queue.shift(); quiz.missed.add(w.id); quiz.again.push(w); nextCard() })
$('#quiz-quit').addEventListener('click', endQuiz)
$('#quiz-finish').addEventListener('click', endQuiz)
$('#quiz-restart').addEventListener('click', startQuiz)
$('#help-close').addEventListener('click', () => { $('#help').hidden = true })
$('#btn-find').addEventListener('click', () => openFind())
$('#empty-find').addEventListener('click', () => openFind())

// ---- backup / restore ----
const backup = async () => {
    busy(true)
    try {
        const { createBackup } = await import('./reader/backup.js')
        const blob = await createBackup()
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `dogear-backup-${new Date().toISOString().slice(0, 10)}.zip`
        document.body.append(a); a.click(); a.remove()
        setTimeout(() => URL.revokeObjectURL(a.href), 60000)
        toast(`backup ready (${fmtSize(blob.size)}) — save it to Files or Drive`, 4000)
    } catch (e) { console.error(e); toast('backup failed: ' + e.message, 4000) } finally { busy(false) }
}
$('#restore-input').addEventListener('change', async () => {
    const f = $('#restore-input').files[0]; $('#restore-input').value = ''
    if (!f) return
    busy(true)
    try {
        const { restoreBackup } = await import('./reader/backup.js')
        const r = await restoreBackup(f)
        await reload()
        toast(`restored: ${r.added} new, ${r.updated} merged`, 4000)
    } catch (e) { console.error(e); toast('restore failed: ' + e.message, 4000) } finally { busy(false) }
})
window.dogearBackup = { backup, restore: f => import('./reader/backup.js').then(m => m.restoreBackup(f)) }

// ---- find free books ----
let findSrc = 'gutenberg', findPage = 1, findBusy = false, catalogMod = null
const openFind = async () => { $('#find').hidden = false; setTimeout(() => $('#find-q').focus(), 200); if (!$('#find-results').children.length) runFind(true) }
$('#find-close').addEventListener('click', () => { $('#find').hidden = true })
$('#find-q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runFind(true); $('#find-q').blur() } })
$$('#find-tabs .tab').forEach(t => t.addEventListener('click', () => { findSrc = t.dataset.src; $$('#find-tabs .tab').forEach(x => x.classList.toggle('active', x === t)); runFind(true) }))
$('#find-more').addEventListener('click', () => runFind(false))
const runFind = async reset => {
    if (findBusy) return
    findBusy = true
    catalogMod ??= await import('./reader/catalog.js')
    const res = $('#find-results')
    if (reset) { findPage = 1; res.innerHTML = '<p class="find-status">searching…</p>' }
    $('#find-more').hidden = true
    try {
        const { items, more } = await catalogMod.SOURCES[findSrc].search($('#find-q').value, findPage)
        if (reset) res.textContent = ''
        if (!items.length && reset) res.innerHTML = '<p class="find-status">nothing found. try another word?</p>'
        for (const it of items) {
            const row = document.createElement('div'); row.className = 'find-item'
            row.innerHTML = `<img alt="" loading="lazy"${it.cover ? ` src="${esc(it.cover)}"` : ''}><div class="fi-text"><div class="fi-t">${esc(it.title)}</div><div class="fi-a">${esc(it.author || '')}${it.language ? ` · ${esc(it.language)}` : ''}</div></div><button class="get">add</button>`
            row.querySelector('img').addEventListener('error', e => { e.target.removeAttribute('src') })
            const btn = row.querySelector('.get')
            btn.addEventListener('click', async () => {
                if (btn.classList.contains('done')) return
                btn.textContent = '…'; btn.disabled = true
                try {
                    await catalogMod.downloadToShelf(findSrc, it, (got, total) => { btn.textContent = `${Math.round(got / total * 100)}%` })
                    btn.textContent = 'added ✓'; btn.classList.add('done'); await reload(); library.persist()
                } catch (e) { console.error(e); btn.textContent = 'add'; btn.disabled = false; toast(e.name === 'TypeError' ? 'that site blocked the download. open it in the browser instead.' : `couldn’t add: ${e.message}`, 4500) }
            })
            res.append(row)
        }
        $('#find-more').hidden = !more
        findPage++
    } catch (e) { console.error(e); if (reset) res.innerHTML = `<p class="find-status">${navigator.onLine ? 'couldn’t reach the catalog right now.' : 'you’re offline.'}</p>` }
    finally { findBusy = false }
}

const addFromUrl = async () => {
    const url = prompt('Paste a direct link to an EPUB, PDF or other book file:')
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
        await reload(); toast('on the shelf'); library.persist()
    } catch (e) {
        console.error(e)
        toast(e.name === 'TypeError' ? 'That site blocks downloads from web apps. Save the file in Safari first, then add it from Files.' : `Download failed: ${e.message}`, 5000)
    } finally { busy(false) }
}

// Files shared to Dogear (Android share target) arrive via the service worker with ?shared=N
{
    const n = +new URLSearchParams(location.search).get('shared')
    if (n > 0) { history.replaceState(null, '', location.pathname); setTimeout(() => toast(n === 1 ? 'shared book added' : `${n} shared books added`), 400) }
}

document.addEventListener('dragover', e => e.preventDefault())
document.addEventListener('drop', e => { e.preventDefault(); importFiles([...e.dataTransfer.files]) })

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
if (isIOS && !standalone && !localStorage.getItem('dogear.hint')) $('#install-hint').hidden = false
$('#hint-close').addEventListener('click', () => { $('#install-hint').hidden = true; localStorage.setItem('dogear.hint', '1') })

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(e => console.warn('sw', e))
    // When an updated worker takes over, reload once so markup, styles and scripts all come from the same version.
    const hadController = !!navigator.serviceWorker.controller // false on the very first visit: no reload then
    let refreshing = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing || !hadController) return
        refreshing = true; location.reload()
    })
}
window.addEventListener('pageshow', e => { if (e.persisted) reload() })
document.addEventListener('visibilitychange', () => { if (!document.hidden) reload() })

reload().catch(e => { console.error(e); toast('Storage unavailable: ' + e.message, 6000) })
