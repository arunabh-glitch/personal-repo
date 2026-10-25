package com.openshelf.reader.reader

import android.webkit.JavascriptInterface
import org.json.JSONObject

/** Methods exposed to reader.js as `window.Android`. Called on a WebView worker thread. */
class ReaderBridge(private val host: Host) {
    interface Host {
        fun bookInfoJson(): String
        fun settingsJson(): String
        fun onSaveSettings(json: String)
        fun onSaveProgress(location: String?, fraction: Double, label: String?)
        fun onMetadata(title: String?, author: String?, coverDataUrl: String?)
        fun onReaderReady()
        fun onReaderError(message: String)
        fun onClose()
        fun onBarsVisible(visible: Boolean)
        fun onKeepScreenOn(on: Boolean)
        fun onOpenExternal(url: String)
    }

    @JavascriptInterface fun getBookInfo(): String = host.bookInfoJson()
    @JavascriptInterface fun getSettings(): String = host.settingsJson()
    @JavascriptInterface fun saveSettings(json: String) = host.onSaveSettings(json)

    @JavascriptInterface
    fun saveProgress(json: String) {
        val o = runCatching { JSONObject(json) }.getOrNull() ?: return
        host.onSaveProgress(
            o.optString("location", "").ifEmpty { null },
            o.optDouble("fraction", 0.0),
            o.optString("label", "").ifEmpty { null },
        )
    }

    @JavascriptInterface
    fun onMetadata(json: String) {
        val o = runCatching { JSONObject(json) }.getOrNull() ?: return
        host.onMetadata(
            o.optString("title", "").ifEmpty { null },
            o.optString("author", "").ifEmpty { null },
            o.optString("cover", "").ifEmpty { null },
        )
    }

    @JavascriptInterface fun onReady() = host.onReaderReady()
    @JavascriptInterface fun onError(message: String) = host.onReaderError(message)
    @JavascriptInterface fun close() = host.onClose()
    @JavascriptInterface fun setBarsVisible(visible: Boolean) = host.onBarsVisible(visible)
    @JavascriptInterface fun keepScreenOn(on: Boolean) = host.onKeepScreenOn(on)
    @JavascriptInterface fun openExternal(url: String) = host.onOpenExternal(url)
}
