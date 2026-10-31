// A 3D page turn for paged books (Display → Page turn → Book flip).
//
// The live page itself is the moving sheet for the first half of the turn: it lifts from its free edge and folds
// toward the spine until it stands edge-on. At that moment nothing of it is visible, so the book quietly swaps to
// the new page underneath. A blank sheet (the back of the page) then finishes the fold and lands on the far side.
// Going back plays the same motion in reverse. No snapshot of the page is ever taken, so it works with any
// renderer, any fonts and any images, and costs nothing while idle.
const EASE_IN = 'cubic-bezier(.5,0,.85,.45)'
const EASE_OUT = 'cubic-bezier(.15,.65,.3,1)'

const run = (el, frames, duration, easing) => el.animate(frames, { duration, easing, fill: 'forwards' }).finished
const div = (cls, parent) => { const el = document.createElement('div'); el.className = cls; parent.append(el); return el }

export class PageFlip {
    #stage; #page; #chain = Promise.resolve(); #pending = 0

    // stage: the element holding the page (gets the perspective); page: the live page element to rotate.
    constructor(stage, page) { this.#stage = stage; this.#page = page }

    // Turns one page. forward: +1 or -1 in reading order; swap: async fn that moves the book to the new page.
    // Turns requested while one is playing queue up (a few at most) so quick taps still skim ahead.
    turn(forward, swap, opts = {}) {
        if (this.#pending >= 3) return Promise.resolve()
        this.#pending++
        const job = () => this.#run(forward, swap, opts).finally(() => this.#pending--)
        return this.#chain = this.#chain.then(job, job)
    }

    async #run(forward, swap, { rtl = false, duration = 400 } = {}) {
        const stage = this.#stage, page = this.#page
        const w = stage.clientWidth || 400
        // the free edge comes toward the reader as the page lifts; negative rotateY does that for a left spine
        const s = rtl ? 1 : -1
        const rot = deg => `rotateY(${deg * s}deg)`
        stage.style.setProperty('--spine', rtl ? 'right' : 'left')
        stage.style.setProperty('--free', rtl ? 'left' : 'right')
        stage.style.setProperty('--flip-persp', Math.max(1400, w * 2.4) + 'px')
        stage.classList.add('flipping')

        const shadow = div('flip-shadow', stage)   // cast on the flat page, next to the spine
        const shade = div('flip-shade', stage)     // rides on the moving live page
        const sheet = div('flip-sheet', stage)     // the blank back of the page
        sheet.style.transform = rot(180)
        const d1 = Math.round(duration * 0.45), d2 = duration - d1

        try {
            if (forward > 0) {
                // 1. the live page lifts from its free edge and folds to the spine, edge-on
                await Promise.all([
                    run(page, [{ transform: rot(0) }, { transform: rot(90) }], d1, EASE_IN),
                    run(shade, [{ transform: rot(0), opacity: 0 }, { transform: rot(90), opacity: 1 }], d1, EASE_IN),
                    run(shadow, [{ opacity: 0 }, { opacity: 1 }], d1, EASE_IN),
                ])
                shade.remove()
                // 2. nothing is visible: lay the page flat (renderers measure themselves with bounding rects,
                //    which collapse while rotated) but keep it hidden, and move the book on
                page.getAnimations().forEach(a => a.cancel())
                await this.#swap(swap, page)
                // 3. the back of the page falls on the far side of the spine
                await Promise.all([
                    run(sheet, [{ transform: rot(90) }, { transform: rot(180) }], d2, EASE_OUT),
                    run(shadow, [{ opacity: 1 }, { opacity: 0 }], d2, EASE_OUT),
                ])
            } else {
                // 1. the back of the previous page rises from the far side until it stands edge-on
                await Promise.all([
                    run(sheet, [{ transform: rot(180) }, { transform: rot(90) }], d1, EASE_IN),
                    run(shadow, [{ opacity: 0 }, { opacity: 1 }], d1, EASE_IN),
                ])
                sheet.remove()
                // 2. the book moves back while the live page is hidden, then the page waits edge-on
                await this.#swap(swap, page, rot(90))
                // 3. the previous page falls flat, face up
                await Promise.all([
                    run(page, [{ transform: rot(90) }, { transform: rot(0) }], d2, EASE_OUT),
                    run(shade, [{ transform: rot(90), opacity: 1 }, { transform: rot(0), opacity: 0 }], d2, EASE_OUT),
                    run(shadow, [{ opacity: 1 }, { opacity: 0 }], d2, EASE_OUT),
                ])
            }
        } finally {
            page.getAnimations().forEach(a => a.cancel())
            page.style.transform = ''
            page.style.visibility = ''
            for (const el of [shadow, shade, sheet]) el.remove()
            stage.classList.remove('flipping')
        }
    }

    // Moves the book while the page is flat and hidden, then shows it again in the given pose and lets it paint.
    async #swap(swap, page, pose = '') {
        page.style.transform = ''
        page.style.visibility = 'hidden'
        try { await swap() } catch (e) { console.warn('page turn failed', e) }
        page.style.transform = pose
        page.style.visibility = ''
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    }
}
