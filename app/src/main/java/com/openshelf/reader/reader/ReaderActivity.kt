package com.openshelf.reader.reader

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import com.openshelf.reader.OpenShelfApp
import com.openshelf.reader.R
import com.openshelf.reader.data.Book
import com.openshelf.reader.data.BookRepository
import com.openshelf.reader.databinding.ActivityReaderBinding
import org.json.JSONObject

class ReaderActivity : AppCompatActivity(), ReaderBridge.Host {
    private lateinit var binding: ActivityReaderBinding
    private lateinit var repo: BookRepository
    private lateinit var book: Book
    private lateinit var assetLoader: WebViewAssetLoader
    private var insetTop = 0
    private var insetBottom = 0
    private var pageReady = false
    private var readerReady = false
    private val lastConsoleErrors = ArrayDeque<String>()
    private val watchdog = Runnable {
        if (!readerReady && !isFinishing) onReaderError(getString(R.string.reader_timeout, webViewVersion()))
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        repo = OpenShelfApp.repo(application)
        val id = intent.getStringExtra(EXTRA_BOOK_ID)
        val found = id?.let { repo.get(it) }
        if (found == null) {
            Toast.makeText(this, getString(R.string.load_failed, "?"), Toast.LENGTH_SHORT).show()
            finish(); return
        }
        book = found
        repo.markOpened(book.id)

        binding = ActivityReaderBinding.inflate(layoutInflater)
        setContentView(binding.root)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        setSystemBars(false)

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/book/", BookPathHandler(repo))
            .build()

        val web = binding.webview
        web.setBackgroundColor(Color.TRANSPARENT)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            textZoom = 100
            cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
        }
        web.addJavascriptInterface(ReaderBridge(this), "Android")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == WebViewAssetLoader.DEFAULT_DOMAIN) return false
                onOpenExternal(url.toString())
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pushInsets()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                val line = "${m.message()} (${m.sourceId().substringAfterLast('/')}:${m.lineNumber()})"
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.e(TAG, "[js] $line")
                    synchronized(lastConsoleErrors) { lastConsoleErrors.addLast(line); while (lastConsoleErrors.size > 5) lastConsoleErrors.removeFirst() }
                } else Log.d(TAG, "[js] $line")
                return true
            }
        }
        ViewCompat.setOnApplyWindowInsetsListener(web) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            insetTop = bars.top; insetBottom = bars.bottom
            pushInsets()
            insets
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(function(){try{return !!(window.onAndroidBack&&window.onAndroidBack())}catch(e){return false}})()") { r ->
                    if (r != "true") { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
                }
            }
        })
        web.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/reader/index.html")
        web.postDelayed(watchdog, WATCHDOG_MS)
    }

    private fun webViewVersion(): String =
        runCatching { WebViewCompat.getCurrentWebViewPackage(this)?.versionName }.getOrNull() ?: "unknown"


    private fun pushInsets() {
        if (!pageReady) return
        val d = resources.displayMetrics.density
        val top = (insetTop / d).toInt(); val bottom = (insetBottom / d).toInt()
        binding.webview.evaluateJavascript(
            "document.documentElement.style.setProperty('--sat','${top}px');" +
                "document.documentElement.style.setProperty('--sab','${bottom}px');", null)
    }

    private fun setSystemBars(visible: Boolean) {
        val c = WindowInsetsControllerCompat(window, binding.root)
        c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (visible) c.show(WindowInsetsCompat.Type.systemBars()) else c.hide(WindowInsetsCompat.Type.systemBars())
    }

    override fun onDestroy() {
        binding.webview.removeCallbacks(watchdog)
        binding.webview.apply { loadUrl("about:blank"); stopLoading(); destroy() }
        super.onDestroy()
    }

    // ---------------- ReaderBridge.Host (called from JS thread) ----------------

    override fun bookInfoJson(): String {
        val fresh = repo.get(book.id) ?: book
        return JSONObject().apply {
            put("id", fresh.id)
            put("title", fresh.title)
            put("author", fresh.author)
            put("format", fresh.format)
            put("fileName", fresh.fileName)
            put("url", "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/book/${fresh.id}/${Uri.encode(fresh.fileName)}")
            put("location", fresh.location ?: JSONObject.NULL)
            put("fraction", fresh.progress)
            put("needsMetadata", !fresh.metadataFetched)
        }.toString()
    }

    override fun settingsJson(): String = prefs().getString(KEY_SETTINGS, null) ?: "{}"

    override fun onSaveSettings(json: String) { prefs().edit().putString(KEY_SETTINGS, json).apply() }

    override fun onSaveProgress(location: String?, fraction: Double, label: String?) {
        repo.updateProgress(book.id, location, fraction, label)
    }

    override fun onMetadata(title: String?, author: String?, coverDataUrl: String?) {
        repo.updateMetadata(book.id, title, author, coverDataUrl)
    }

    override fun onReaderReady() = runOnUiThread {
        readerReady = true
        binding.webview.removeCallbacks(watchdog)
        binding.loading.visibility = View.GONE
    }

    override fun onReaderError(message: String) = runOnUiThread {
        readerReady = true
        binding.webview.removeCallbacks(watchdog)
        binding.loading.visibility = View.GONE
        val extra = synchronized(lastConsoleErrors) { lastConsoleErrors.joinToString("\n") }
        val full = if (extra.isNotBlank() && !message.contains(extra.lineSequence().first())) "$message\n$extra" else message
        Log.e(TAG, "reader error: $full (WebView ${webViewVersion()})")
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(R.string.reader_error_title)
            .setMessage(getString(R.string.reader_error, full) + "\n\nWebView ${webViewVersion()}")
            .setPositiveButton(R.string.ok) { _, _ -> finish() }
            .setNeutralButton(R.string.retry) { _, _ -> recreate() }
            .setOnCancelListener { finish() }
            .show()
    }

    override fun onClose() = runOnUiThread { finish() }

    override fun onBarsVisible(visible: Boolean) = runOnUiThread { setSystemBars(visible) }

    override fun onKeepScreenOn(on: Boolean) = runOnUiThread {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    override fun onOpenExternal(url: String) = runOnUiThread {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            .onFailure { Toast.makeText(this, url, Toast.LENGTH_SHORT).show() }
    }

    private fun prefs() = getSharedPreferences("reader", Context.MODE_PRIVATE)

    companion object {
        private const val TAG = "ReaderActivity"
        const val EXTRA_BOOK_ID = "book_id"
        private const val KEY_SETTINGS = "settings"
        private const val WATCHDOG_MS = 30_000L

        fun start(context: Context, bookId: String) {
            context.startActivity(Intent(context, ReaderActivity::class.java).putExtra(EXTRA_BOOK_ID, bookId))
        }
    }
}
