// Tap-to-define dictionary: free online sources with a local cache so words you
// have looked up before work offline.
const CACHE_KEY = 'dogear.dict.v1'
const MAX_CACHE = 400

const loadCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') } catch { return {} } }
let cache = loadCache()
const saveCache = () => {
    try {
        const keys = Object.keys(cache)
        if (keys.length > MAX_CACHE) for (const k of keys.slice(0, keys.length - MAX_CACHE)) delete cache[k]
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
    } catch { /* storage full or unavailable */ }
}

export const normalizeWord = raw => (raw || '')
    .replace(/[‘’]/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')
    .replace(/'s$/i, '')
    .trim()

// Crude English stemming for inflected forms the dictionary may not list.
const candidates = word => {
    const w = word.toLowerCase()
    const out = [word, w]
    const rules = [
        [/ies$/, 'y'], [/ied$/, 'y'], [/ier$/, 'y'], [/iest$/, 'y'],
        [/sses$/, 'ss'], [/xes$/, 'x'], [/ches$/, 'ch'], [/shes$/, 'sh'],
        [/ing$/, ''], [/ing$/, 'e'], [/ying$/, 'ie'],
        [/ed$/, ''], [/ed$/, 'e'], [/est$/, ''], [/er$/, ''], [/ly$/, ''],
        [/ness$/, ''], [/ments?$/, ''], [/s$/, ''],
    ]
    for (const [re, rep] of rules) if (re.test(w)) {
        const c = w.replace(re, rep)
        if (c.length >= 3) {
            out.push(c)
            if (/(.)\1$/.test(c)) out.push(c.slice(0, -1)) // running → runn → run
        }
    }
    return [...new Set(out)]
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

const fromDictionaryApi = async word => {
    const res = await withTimeout(fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`), 7000)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data) || !data.length) return null
    const entry = data[0]
    const audio = data.flatMap(e => e.phonetics || []).find(p => p.audio)?.audio || null
    const phonetic = entry.phonetic || data.flatMap(e => e.phonetics || []).find(p => p.text)?.text || ''
    const meanings = []
    for (const e of data) for (const m of e.meanings || []) {
        meanings.push({
            pos: m.partOfSpeech,
            defs: (m.definitions || []).slice(0, 4).map(d => ({ def: d.definition, example: d.example || null })),
            synonyms: (m.synonyms || []).slice(0, 6),
        })
    }
    return { word: entry.word, phonetic, audio: audio && audio.startsWith('//') ? 'https:' + audio : audio, meanings: meanings.slice(0, 5), source: 'dictionaryapi.dev', url: `https://en.wiktionary.org/wiki/${encodeURIComponent(entry.word)}` }
}

const strip = html => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent.replace(/\s+/g, ' ').trim() }

const fromWiktionary = async word => {
    const res = await withTimeout(fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}?redirect=true`, { headers: { Accept: 'application/json' } }), 7000)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const en = data.en || Object.values(data)[0]
    if (!en?.length) return null
    const meanings = en.slice(0, 5).map(m => ({
        pos: (m.partOfSpeech || '').toLowerCase(),
        defs: (m.definitions || []).filter(d => d.definition).slice(0, 4).map(d => ({ def: strip(d.definition), example: d.parsedExamples?.[0]?.example ? strip(d.parsedExamples[0].example) : (d.examples?.[0] ? strip(d.examples[0]) : null) })),
        synonyms: [],
    })).filter(m => m.defs.length)
    if (!meanings.length) return null
    return { word, phonetic: '', audio: null, meanings, source: 'Wiktionary', url: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}` }
}

/** Returns { word, phonetic, audio, meanings, source, url } or null when the word is unknown. Throws when offline. */
export const lookup = async raw => {
    const word = normalizeWord(raw)
    if (!word) return null
    const key = word.toLowerCase()
    if (cache[key]) return cache[key]
    let lastError = null
    for (const c of candidates(word)) {
        for (const src of [fromDictionaryApi, fromWiktionary]) {
            try {
                const r = await src(c)
                if (r) { cache[key] = r; saveCache(); return r }
            } catch (e) { lastError = e }
        }
    }
    if (lastError && !navigator.onLine) throw new Error('offline')
    if (lastError) throw lastError
    return null
}

export const speak = (word, audioUrl) => {
    if (audioUrl) {
        const a = new Audio(audioUrl)
        return a.play().catch(() => speakTTS(word))
    }
    return speakTTS(word)
}
const speakTTS = word => {
    try {
        if (!('speechSynthesis' in window)) return
        const u = new SpeechSynthesisUtterance(word)
        u.lang = 'en'
        u.rate = 0.9
        speechSynthesis.cancel()
        speechSynthesis.speak(u)
    } catch { /* ignore */ }
}

/** Picks the word at the caret from a selection/point so a double tap or long press can define it. */
export const selectedPhrase = sel => {
    if (!sel || sel.isCollapsed) return ''
    const text = sel.toString().replace(/\s+/g, ' ').trim()
    if (!text || text.length > 60) return ''
    const words = text.split(' ').filter(Boolean)
    if (words.length > 4) return ''
    return text
}
