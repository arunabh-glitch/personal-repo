// Free translation (MyMemory) with a local cache. Short passages only.
const CACHE_KEY = 'dogear.tr.v1'
const MAX = 300
let cache = (() => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') } catch { return {} } })()
const save = () => { try { const k = Object.keys(cache); if (k.length > MAX) for (const x of k.slice(0, k.length - MAX)) delete cache[x]; localStorage.setItem(CACHE_KEY, JSON.stringify(cache)) } catch { /* ignore */ } }

export const LANGS = [
    ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['hi', 'Hindi'],
    ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu'], ['mr', 'Marathi'], ['ja', 'Japanese'], ['ko', 'Korean'],
    ['zh-CN', 'Chinese'], ['ar', 'Arabic'], ['ru', 'Russian'], ['tr', 'Turkish'], ['nl', 'Dutch'], ['pl', 'Polish'],
    ['sv', 'Swedish'], ['id', 'Indonesian'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['en', 'English'],
]

export const defaultTarget = () => {
    const nav = (navigator.language || 'en').toLowerCase()
    const primary = nav.split('-')[0]
    if (primary === 'zh') return 'zh-CN'
    const known = LANGS.find(([c]) => c === primary)
    return known && primary !== 'en' ? primary : 'es'
}

export const translate = async (text, target, source = 'en') => {
    const q = (text || '').replace(/\s+/g, ' ').trim().slice(0, 450)
    if (!q) return null
    const src = (source || 'en').split('-')[0]
    if (src === target.split('-')[0]) return { text: q, source: 'same language' }
    const key = `${src}|${target}|${q}`
    if (cache[key]) return cache[key]
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(src)}|${encodeURIComponent(target)}`
    const res = await Promise.race([fetch(url), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))])
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const out = data?.responseData?.translatedText
    if (!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(out)) throw new Error(out && out.length < 160 ? out : 'No translation')
    const r = { text: out, source: 'MyMemory' }
    cache[key] = r; save()
    return r
}
