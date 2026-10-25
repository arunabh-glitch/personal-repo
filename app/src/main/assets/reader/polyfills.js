// Small polyfills so the reader runs on older Android System WebView builds.
// Loaded as a classic script before the module entry point.
(function () {
    'use strict'
    if (!Object.groupBy) Object.groupBy = function (items, cb) {
        const out = Object.create(null); let i = 0
        for (const item of items) { const k = cb(item, i++); (out[k] || (out[k] = [])).push(item) }
        return out
    }
    if (!Map.groupBy) Map.groupBy = function (items, cb) {
        const out = new Map(); let i = 0
        for (const item of items) { const k = cb(item, i++); const a = out.get(k); if (a) a.push(item); else out.set(k, [item]) }
        return out
    }
    const at = function (n) { n = Math.trunc(n) || 0; if (n < 0) n += this.length; return n < 0 || n >= this.length ? undefined : this[n] }
    for (const proto of [Array.prototype, String.prototype, Uint8Array.prototype, Int32Array.prototype, Float32Array.prototype])
        if (!proto.at) Object.defineProperty(proto, 'at', { value: at, writable: true, configurable: true })
    if (!Array.prototype.findLast) Object.defineProperty(Array.prototype, 'findLast', { writable: true, configurable: true, value: function (fn, thisArg) {
        for (let i = this.length - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return this[i]
    } })
    if (!Array.prototype.findLastIndex) Object.defineProperty(Array.prototype, 'findLastIndex', { writable: true, configurable: true, value: function (fn, thisArg) {
        for (let i = this.length - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return i
        return -1
    } })
    if (!Array.prototype.toSorted) Object.defineProperty(Array.prototype, 'toSorted', { writable: true, configurable: true, value: function (cmp) { return this.slice().sort(cmp) } })
    if (!Array.prototype.toReversed) Object.defineProperty(Array.prototype, 'toReversed', { writable: true, configurable: true, value: function () { return this.slice().reverse() } })
    if (!String.prototype.replaceAll) Object.defineProperty(String.prototype, 'replaceAll', { writable: true, configurable: true, value: function (s, r) {
        if (s instanceof RegExp) { if (!s.global) throw new TypeError('replaceAll must be called with a global RegExp'); return this.replace(s, r) }
        return this.split(String(s)).join(typeof r === 'function' ? r() : r)
    } })
    if (!Object.hasOwn) Object.hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
    if (!Promise.withResolvers) Promise.withResolvers = function () {
        let resolve, reject
        const promise = new this((res, rej) => { resolve = res; reject = rej })
        return { promise, resolve, reject }
    }
    if (!Promise.any) Promise.any = promises => new Promise((resolve, reject) => {
        const errs = []; let pending = 0
        for (const p of promises) { pending++; Promise.resolve(p).then(resolve, e => { errs.push(e); if (--pending === 0) reject(new AggregateError(errs, 'All promises were rejected')) }) }
        if (pending === 0) reject(new AggregateError(errs, 'All promises were rejected'))
    })
    if (typeof AggregateError === 'undefined') globalThis.AggregateError = class AggregateError extends Error { constructor(errors, message) { super(message); this.errors = errors } }
    if (!globalThis.structuredClone) globalThis.structuredClone = function clone(v, seen = new Map()) {
        if (v === null || typeof v !== 'object') return v
        if (seen.has(v)) return seen.get(v)
        if (v instanceof Date) return new Date(v)
        if (v instanceof RegExp) return new RegExp(v.source, v.flags)
        if (ArrayBuffer.isView(v)) return new v.constructor(v)
        if (v instanceof ArrayBuffer) return v.slice(0)
        if (v instanceof Map) { const m = new Map(); seen.set(v, m); for (const [k, x] of v) m.set(clone(k, seen), clone(x, seen)); return m }
        if (v instanceof Set) { const s = new Set(); seen.set(v, s); for (const x of v) s.add(clone(x, seen)); return s }
        if (Array.isArray(v)) { const a = []; seen.set(v, a); for (const x of v) a.push(clone(x, seen)); return a }
        const o = {}; seen.set(v, o)
        for (const k of Object.keys(v)) o[k] = clone(v[k], seen)
        return o
    }
    if (!globalThis.reportError) globalThis.reportError = e => console.error(e)
})()
