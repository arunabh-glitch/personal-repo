package com.openshelf.reader.data

import java.util.Locale

/** Supported file formats, keyed by canonical extension. */
object Formats {
    val supported: Set<String> = setOf(
        "epub", "pdf", "mobi", "azw", "azw3", "kf8", "prc", "fb2", "fbz", "cbz",
        "txt", "md", "markdown", "html", "htm", "xhtml",
    )

    private val byMime = mapOf(
        "application/epub+zip" to "epub",
        "application/pdf" to "pdf",
        "application/x-mobipocket-ebook" to "mobi",
        "application/vnd.amazon.ebook" to "azw3",
        "application/vnd.amazon.mobi8-ebook" to "azw3",
        "application/x-fictionbook+xml" to "fb2",
        "application/x-zip-compressed-fb2" to "fbz",
        "application/vnd.comicbook+zip" to "cbz",
        "application/x-cbz" to "cbz",
        "text/plain" to "txt",
        "text/markdown" to "md",
        "text/x-markdown" to "md",
        "text/html" to "html",
        "application/xhtml+xml" to "xhtml",
    )

    fun mimeFor(format: String): String = byMime.entries.firstOrNull { it.value == format }?.key
        ?: when (format) {
            "azw", "kf8", "prc" -> "application/x-mobipocket-ebook"
            "markdown" -> "text/markdown"
            "htm" -> "text/html"
            else -> "application/octet-stream"
        }

    fun fromName(name: String?): String? {
        if (name == null) return null
        val lower = name.lowercase(Locale.ROOT).substringAfterLast('/')
        if (lower.endsWith(".fb2.zip")) return "fbz"
        val ext = lower.substringAfterLast('.', "")
        return if (ext in supported) ext else null
    }

    fun fromMime(mime: String?): String? {
        if (mime == null) return null
        return byMime[mime.substringBefore(';').trim().lowercase(Locale.ROOT)]
    }

    /** Prefer the file name (MIME types from file managers are often generic). */
    fun detect(name: String?, mime: String?): String? = fromName(name) ?: fromMime(mime)

    fun label(format: String): String = when (format) {
        "epub" -> "EPUB"; "pdf" -> "PDF"; "mobi", "prc" -> "MOBI"; "azw" -> "AZW"
        "azw3", "kf8" -> "AZW3"; "fb2", "fbz" -> "FB2"; "cbz" -> "CBZ"; "txt" -> "TXT"
        "md", "markdown" -> "Markdown"; "html", "htm", "xhtml" -> "HTML"; else -> format.uppercase(Locale.ROOT)
    }

    /** Download MIME types the catalog browser considers readable. */
    fun isReadableMime(mime: String?): Boolean = fromMime(mime) != null
}
