// Lumi, the reading companion: a small layered figure in the corner that reads along, reacts to what you do,
// and says something now and then. Poses are the original artwork split into body / eyes / sparkle layers.
export const POSES = {"reading": {"w": 406, "h": 396, "eyes": [43.8, 45.1], "spark": [88.2, 13.3], "blink": true}, "lying": {"w": 298, "h": 204, "eyes": [30.9, 56.9], "spark": [64.1, 13.7], "blink": true}, "happy": {"w": 251, "h": 217, "eyes": [53.0, 36.6], "spark": [50.4, 36.4], "blink": false}, "stack": {"w": 257, "h": 230, "eyes": [57.4, 32.4], "spark": [82.3, 13.7], "blink": true}, "blanket": {"w": 326, "h": 208, "eyes": [55.5, 48.6], "spark": [78.5, 24.0], "blink": false}, "thinking": {"w": 241, "h": 259, "eyes": [46.5, 43.4], "spark": [80.5, 16.2], "blink": true}}

export const lumiHTML = (name, cls = '', base = 'brand/') => {
    const m = POSES[name]
    return `<div class="lumi ${cls}" data-pose="${name}"${m.blink ? ' data-blink' : ''} style="--eyes:${m.eyes[0]}% ${m.eyes[1]}%;--spark:${m.spark[0]}% ${m.spark[1]}%;aspect-ratio:${m.w}/${m.h}">` +
        ['body', 'eyes', 'spark'].map(l => `<img class="l-${l}" src="${base}lumi-${name}-${l}.png" alt="" width="${m.w}" height="${m.h}">`).join('') + '</div>'
}
export const setPose = (el, name, base = 'brand/') => {
    const m = POSES[name]; if (!el || !m || el.dataset.pose === name) return
    el.dataset.pose = name; el.toggleAttribute('data-blink', m.blink)
    el.style.setProperty('--eyes', `${m.eyes[0]}% ${m.eyes[1]}%`); el.style.setProperty('--spark', `${m.spark[0]}% ${m.spark[1]}%`); el.style.aspectRatio = `${m.w}/${m.h}`
    for (const l of ['body', 'eyes', 'spark']) { const img = el.querySelector('.l-' + l); img.src = `${base}lumi-${name}-${l}.png`; img.width = m.w; img.height = m.h }
}

const LINES = {
    morning: ['morning. where were we?', 'early pages hit different.', 'coffee and a chapter?'],
    afternoon: ['right, where were we?', 'afternoon read. nice.', 'a few pages before the day gets loud?'],
    evening: ['evening read?', 'let’s pick it back up.', 'best part of the day, this.'],
    late: ['it’s late. one more chapter, then sleep?', 'past bedtime. i’ll keep the page warm.', 'eyes heavy? the book will wait.'],
    resume: ['back at {pct}. let’s go.', '{pct} in. picking up the thread.'],
    chapter: ['chapter done ✓', 'that’s a chapter. onwards.', 'nice, next one.', 'another one down.'],
    pages: ['good pace.', 'you’re flying.', 'look at you go.'],
    highlight: ['good line.', 'saving that one too.', 'ooh, yes.', 'underlined in my copy as well.'],
    word: ['new word for the pile.', 'that’s a keeper.', 'adding it to my list too.'],
    long: { 45: '45 minutes in. stretch?', 60: 'an hour. water break?', 90: 'ninety minutes. legend. maybe blink?', 120: 'two hours. i’m impressed and a little worried.' },
    idle: ['still there?', 'i’ll wait.', 'no rush.'],
    tap: ['hi.', 'this part’s good.', 'still here.', 'reading with you.', 'don’t mind me.', 'same page as you.'],
    tapSleepy: ['zzz… oh, hi.', 'five more minutes…', 'mm? still reading?'],
    wake: ['oh. hi again.', 'back! where were we?'],
    listen: ['i’ll listen too.', 'read it to us.'],
}
const pick = arr => arr[Math.floor(Math.random() * arr.length)]

export class Companion {
    constructor(root, { enabled = true, reduceMotion = false, clock = () => new Date(), onPose } = {}) {
        this.root = root; this.enabled = enabled; this.reduceMotion = reduceMotion; this.clock = clock; this.onPose = onPose
        this.bubble = root.querySelector('.comp-bubble'); this.figure = root.querySelector('.lumi')
        this.lastSaid = 0; this.lastReact = 0; this.pages = 0; this.chapter = null; this.lastPageAt = Date.now(); this.sessionSeconds = 0
        this.saidLong = new Set(); this.saidLate = false; this.greeted = false; this.asleep = false; this.listening = false
        this.figure.addEventListener('click', e => { e.stopPropagation(); this.tap() })
        this.bubble.addEventListener('click', () => this.hush())
        root.hidden = !enabled
        this.timer = setInterval(() => this.#idleCheck(), 30000)
    }
    get late() { const h = this.clock().getHours(); return h >= 23 || h < 5 }
    get baseline() { return this.late || this.asleep ? 'blanket' : 'reading' }
    setEnabled(v) { this.enabled = v; this.root.hidden = !v; if (!v) this.hush() }
    tuck(v) { this.root.classList.toggle('tucked', !!v) }
    pose(name, ms) {
        setPose(this.figure, name); this.onPose?.(name)
        clearTimeout(this.poseTimer)
        if (ms) this.poseTimer = setTimeout(() => setPose(this.figure, this.baseline), ms)
    }
    hop() { if (this.reduceMotion) return; this.figure.classList.remove('is-happy'); void this.figure.offsetWidth; this.figure.classList.add('is-happy'); setTimeout(() => this.figure.classList.remove('is-happy'), 800) }
    say(text, ms = 3600) {
        if (!this.enabled || !text) return false
        this.bubble.textContent = text; this.bubble.hidden = false
        this.bubble.classList.remove('pop'); void this.bubble.offsetWidth; this.bubble.classList.add('pop')
        clearTimeout(this.sayTimer); this.sayTimer = setTimeout(() => this.hush(), ms)
        this.lastSaid = Date.now(); return true
    }
    hush() { this.bubble.hidden = true }
    // unsolicited remarks are rare: at most one every 75 seconds
    #remark(text, ms) { if (Date.now() - this.lastSaid < 75000) return false; return this.say(text, ms) }
    // direct responses to the reader's own action: quick, but not more than one every 6 seconds
    #respond(text, ms) { if (Date.now() - this.lastReact < 6000) return false; this.lastReact = Date.now(); return this.say(text, ms) }
    #wakeIfNeeded() { if (this.asleep) { this.asleep = false; this.pose(this.baseline); this.say(pick(LINES.wake), 2500) } }
    #idleCheck() {
        if (!this.enabled || document.hidden) return
        const idleFor = Date.now() - this.lastPageAt
        if (!this.asleep && idleFor > 4 * 60000) { this.asleep = true; this.pose('blanket') }
        else if (!this.asleep && idleFor > 2 * 60000 && !this.late) this.#remark(pick(LINES.idle), 2800)
    }
    greet(fraction = 0) {
        if (this.greeted || !this.enabled) return; this.greeted = true
        const h = this.clock().getHours()
        if (this.late) { this.saidLate = true; this.pose('blanket'); setTimeout(() => this.say(pick(LINES.late), 5000), 1500); return }
        const line = fraction > 0.04 ? pick(LINES.resume).replace('{pct}', Math.round(fraction * 100) + '%') : pick(h < 12 ? LINES.morning : h < 18 ? LINES.afternoon : LINES.evening)
        setTimeout(() => { this.say(line, 4000); this.hop() }, 1500)
    }
    react(kind, data = {}) {
        if (!this.enabled) return
        switch (kind) {
            case 'page': {
                this.lastPageAt = Date.now(); this.#wakeIfNeeded()
                const label = data.chapter || ''
                if (this.chapter != null && label && label !== this.chapter && this.pages > 3) { this.pose('happy', 2200); this.hop(); this.#remark(pick(LINES.chapter), 2800) }
                if (label) this.chapter = label
                this.pages++
                if (this.pages % 12 === 0) { this.hop(); if (this.pages % 36 === 0) this.#remark(pick(LINES.pages), 2500) }
                break
            }
            case 'highlight': this.pose('happy', 2200); this.hop(); this.#respond(pick(LINES.highlight), 3000); break
            case 'word': this.pose('happy', 2200); this.hop(); this.#respond(pick(LINES.word), 3000); break
            case 'lookup': this.pose('thinking', 2600); break
            case 'listen': this.listening = !!data.on; this.root.classList.toggle('listening', this.listening); if (this.listening) this.#respond(pick(LINES.listen), 2500); break
            case 'tick': {
                this.sessionSeconds = data.seconds || 0
                const m = Math.floor(this.sessionSeconds / 60)
                for (const at of [45, 60, 90, 120]) if (m >= at && !this.saidLong.has(at)) { this.saidLong.add(at); this.pose('lying', 6000); this.say(LINES.long[at], 5000); break }
                if (this.late && !this.saidLate && m >= 8) { this.saidLate = true; this.pose('blanket'); this.say(pick(LINES.late), 5000) }
                break
            }
            case 'visible': if (data.on) { this.lastPageAt = Date.now() } break
        }
    }
    tap() {
        if (!this.enabled) return
        if (this.asleep || this.late) { this.say(pick(LINES.tapSleepy), 2500); if (this.asleep) this.#wakeIfNeeded(); return }
        this.pose('happy', 1800); this.hop(); this.say(pick(LINES.tap), 2200)
    }
    destroy() { clearInterval(this.timer) }
}
