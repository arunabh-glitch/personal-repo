package com.openshelf.reader.catalog

import android.net.Uri
import com.openshelf.reader.data.Book
import com.openshelf.reader.data.BookRepository
import com.openshelf.reader.data.Formats
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder

/** Downloads a book from a URL straight into the library. Runs on the caller's (IO) thread. */
object Downloader {
    @Throws(IOException::class)
    fun download(repo: BookRepository, url: String, titleHint: String?, mimeHint: String?): Book {
        var current = url
        repeat(8) {
            val conn = (URL(current).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = 20_000
                readTimeout = 60_000
                setRequestProperty("User-Agent", "OpenShelf/1.0 (Android)")
                setRequestProperty("Accept", "*/*")
            }
            val code = conn.responseCode
            if (code in 300..399) {
                val loc = conn.getHeaderField("Location") ?: throw IOException("Redirect without location")
                conn.disconnect()
                current = Opds.resolve(current, loc)
                return@repeat
            }
            if (code >= 400) { conn.disconnect(); throw IOException("HTTP $code") }

            val contentType = conn.contentType
            val name = fileNameFrom(conn.getHeaderField("Content-Disposition"), current, contentType, mimeHint, titleHint)
            val mime = listOf(contentType, mimeHint).firstOrNull { Formats.fromMime(it) != null }
            return conn.inputStream.use { repo.importStream(it, name, mime, url) }
        }
        throw IOException("Too many redirects")
    }

    private fun fileNameFrom(disposition: String?, url: String, contentType: String?, mimeHint: String?, titleHint: String?): String {
        var name: String? = null
        if (disposition != null) {
            Regex("filename\\*=(?:UTF-8|utf-8)''([^;]+)").find(disposition)?.let { name = URLDecoder.decode(it.groupValues[1].trim(), "UTF-8") }
            if (name == null) Regex("filename=\"?([^\";]+)\"?").find(disposition)?.let { name = it.groupValues[1].trim() }
        }
        if (name == null) {
            val last = Uri.parse(url).lastPathSegment
            if (last != null && Formats.fromName(last) != null) name = last
        }
        val ext = Formats.fromName(name) ?: Formats.fromMime(contentType) ?: Formats.fromMime(mimeHint)
        if (name == null || Formats.fromName(name) == null) {
            val base = (titleHint ?: name ?: Uri.parse(url).lastPathSegment ?: "book").replace(Regex("[\\\\/:*?\"<>|]"), " ").trim()
            name = if (ext != null) "$base.${if (ext == "fbz") "fb2.zip" else ext}" else base
        }
        return name!!
    }
}
