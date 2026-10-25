package com.openshelf.reader.reader

import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import com.openshelf.reader.data.BookRepository
import com.openshelf.reader.data.Formats
import java.io.FileInputStream

/** Serves library files to the reader page at https://appassets.androidplatform.net/book/<id>/<name>. */
class BookPathHandler(private val repo: BookRepository) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
        val id = path.trimStart('/').substringBefore('/')
        val book = repo.get(id) ?: return WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), null)
        val file = repo.fileFor(book)
        if (!file.exists()) return WebResourceResponse("text/plain", "utf-8", 404, "Missing file", emptyMap(), null)
        val headers = mapOf(
            "Cache-Control" to "no-store",
            "Content-Length" to file.length().toString(),
        )
        return WebResourceResponse(Formats.mimeFor(book.format), null, 200, "OK", headers, FileInputStream(file))
    }
}
