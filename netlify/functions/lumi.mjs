// Lumi's own model: a small relay so readers never need an API key. The app posts Lumi's persona and the
// conversation here; this function calls Claude through Netlify's AI Gateway (credentials are injected at
// runtime, nothing to configure) and streams the reply back as the same server-sent events the app already
// understands from talking to Claude directly. Cost falls on the Netlify account, so the relay is strict:
// only the app's own origins, small inputs, short replies, and a per-IP rate limit.
import Anthropic from '@anthropic-ai/sdk'

const env = k => (globalThis.Netlify?.env?.get(k)) ?? process.env[k]
const MODEL = () => env('LUMI_MODEL') || 'claude-haiku-5-5'
const MAX_SYSTEM = 16000, MAX_MESSAGES = 24, MAX_CONTENT = 4000, MAX_TOKENS = 700

const originAllowed = o => {
    if (!o) return true // same-origin or non-browser callers carry no Origin header
    try {
        const u = new URL(o)
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true
        if (u.protocol !== 'https:') return false
        if (u.hostname === 'arunabh-glitch.github.io') return true
        if (u.hostname === 'openshelf-reader.netlify.app' || u.hostname.endsWith('--openshelf-reader.netlify.app')) return true
        const extra = (env('LUMI_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean)
        return extra.includes(u.origin)
    } catch { return false }
}
const corsFor = origin => origin ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'origin' } : {}
const json = (body, status, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** Keeps only what the model needs and refuses anything oversized. Returns { system, messages } or a string error. */
export const sanitize = body => {
    if (!body || typeof body !== 'object') return 'body must be a JSON object'
    const system = typeof body.system === 'string' ? body.system.slice(0, MAX_SYSTEM) : ''
    if (!system) return 'missing system'
    if (!Array.isArray(body.messages) || !body.messages.length) return 'missing messages'
    const messages = []
    for (const m of body.messages.slice(-MAX_MESSAGES)) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return 'bad message'
        const content = m.content.slice(0, MAX_CONTENT).trim()
        if (!content) continue
        if (messages.length && messages[messages.length - 1].role === m.role) messages[messages.length - 1].content += '\n\n' + content
        else messages.push({ role: m.role, content })
    }
    while (messages.length && messages[0].role !== 'user') messages.shift()
    if (!messages.length || messages[messages.length - 1].role !== 'user') return 'conversation must end with the reader'
    return { system, messages }
}

export default async (req, context) => {
    const origin = req.headers.get('origin') || ''
    const ok = originAllowed(origin)
    const cors = ok ? corsFor(origin) : {}
    if (req.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers: cors })
    if (!ok) return json({ error: { message: 'origin not allowed' } }, 403)
    if (req.method !== 'POST') return json({ error: { message: 'POST only' } }, 405, cors)
    if (!env('ANTHROPIC_BASE_URL') && !env('ANTHROPIC_API_KEY')) return json({ error: { message: 'no model configured' } }, 503, cors)

    let body
    try { body = await req.json() } catch { return json({ error: { message: 'invalid JSON' } }, 400, cors) }
    const clean = sanitize(body)
    if (typeof clean === 'string') return json({ error: { message: clean } }, 400, cors)

    let events
    try {
        const client = new Anthropic() // ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL are injected by the AI Gateway
        events = await client.messages.create({
            model: MODEL(), max_tokens: MAX_TOKENS, stream: true,
            system: [{ type: 'text', text: clean.system, cache_control: { type: 'ephemeral' } }],
            messages: clean.messages,
        })
    } catch (e) {
        const status = e?.status === 429 ? 429 : e?.status === 401 || e?.status === 403 ? 503 : 502
        console.error('lumi relay', e?.status, e?.message)
        return json({ error: { message: status === 503 ? 'model not available' : status === 429 ? 'rate limited' : 'model error' } }, status, cors)
    }

    const enc = new TextEncoder()
    const stream = new ReadableStream({
        async start(ctrl) {
            const send = ev => ctrl.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`))
            try {
                for await (const ev of events) {
                    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') send(ev)
                    else if (ev.type === 'message_delta') send({ type: 'message_delta', delta: { stop_reason: ev.delta?.stop_reason ?? null } })
                    else if (ev.type === 'message_stop') send(ev)
                }
            } catch (e) {
                console.error('lumi stream', e?.message)
                send({ type: 'error', error: { message: 'the reply was cut off' } })
            }
            ctrl.close()
        },
    })
    return new Response(stream, { headers: { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
}

export const config = {
    path: '/api/lumi',
    method: ['POST', 'OPTIONS'],
    // each reader gets a generous conversation; a scraper hammering the endpoint does not
    rateLimit: { action: 'rate_limit', aggregateBy: ['ip'], windowSize: 60, windowLimit: 20 },
}
