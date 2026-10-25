// Surfaces startup failures (syntax errors in modules, unsupported APIs) as a
// visible message and reports them to the Android host. Classic script, runs first.
(function () {
    'use strict'
    const show = function (msg) {
        try {
            const loading = document.getElementById('loading')
            const error = document.getElementById('error')
            const text = document.getElementById('error-text')
            if (loading) loading.hidden = true
            if (error && error.hidden) {
                error.hidden = false
                if (text) text.textContent = msg
                const back = document.getElementById('error-back')
                if (back) back.onclick = function () { if (window.Android) window.Android.close(); else history.back() }
            }
        } catch (e) { /* ignore */ }
        try { if (window.Android && window.Android.onError) window.Android.onError(String(msg)) } catch (e) { /* ignore */ }
    }
    window.__openshelfShowError = show
    window.addEventListener('error', function (e) {
        const msg = e && e.message ? e.message : 'Script error'
        if (document.readyState !== 'complete' || !window.reader) show(msg + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : ''))
    })
    window.addEventListener('unhandledrejection', function (e) {
        const r = e && e.reason
        const msg = r && r.message ? r.message : String(r)
        if (!window.reader || !window.reader.book && !window.reader.pdf) show(msg)
    })
})()
