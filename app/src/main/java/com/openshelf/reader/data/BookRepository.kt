package com.openshelf.reader.data

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.UUID

/**
 * Stores imported books under the app's private storage and keeps a small
 * JSON index with metadata and reading progress.
 */
class BookRepository(private val context: Context) {
    private val booksDir = File(context.filesDir, "books").apply { mkdirs() }
    private val coversDir = File(context.filesDir, "covers").apply { mkdirs() }
    private val indexFile = File(context.filesDir, "library.json")
    private val lock = Any()
    private var cache: MutableList<Book>? = null

    fun all(): List<Book> = synchronized(lock) { load().map { it.copy() } }

    fun get(id: String): Book? = synchronized(lock) { load().firstOrNull { it.id == id }?.copy() }

    fun fileFor(book: Book): File = File(booksDir, book.fileName)

    fun coverFor(book: Book): File? = File(coversDir, "${book.id}.jpg").takeIf { book.hasCover && it.exists() }

    fun coverFileFor(id: String): File = File(coversDir, "$id.jpg")

    fun save(book: Book) = synchronized(lock) {
        val list = load()
        val i = list.indexOfFirst { it.id == book.id }
        if (i >= 0) list[i] = book else list.add(book)
        persist(list)
    }

    fun delete(book: Book) = synchronized(lock) {
        val list = load()
        list.removeAll { it.id == book.id }
        persist(list)
        fileFor(book).delete()
        coverFileFor(book.id).delete()
    }

    fun updateProgress(id: String, location: String?, fraction: Double, label: String?) = synchronized(lock) {
        val b = load().firstOrNull { it.id == id } ?: return
        b.location = location
        b.progress = fraction.coerceIn(0.0, 1.0)
        b.progressLabel = label
        b.lastOpenedAt = System.currentTimeMillis()
        persist(load())
    }

    fun markOpened(id: String) = synchronized(lock) {
        val b = load().firstOrNull { it.id == id } ?: return
        b.lastOpenedAt = System.currentTimeMillis()
        persist(load())
    }

    /** Called by the reader once it has parsed the book: fills in title/author/cover. */
    fun updateMetadata(id: String, title: String?, author: String?, coverDataUrl: String?) = synchronized(lock) {
        val b = load().firstOrNull { it.id == id } ?: return
        if (!title.isNullOrBlank()) b.title = title.trim()
        if (!author.isNullOrBlank()) b.author = author.trim()
        if (!coverDataUrl.isNullOrBlank()) {
            try {
                val base64 = coverDataUrl.substringAfter(",", "")
                if (base64.isNotEmpty()) {
                    val bytes = Base64.decode(base64, Base64.DEFAULT)
                    coverFileFor(id).writeBytes(bytes)
                    b.hasCover = true
                }
            } catch (e: Exception) {
                Log.w(TAG, "cover decode failed", e)
            }
        }
        b.metadataFetched = true
        persist(load())
    }

    // ---------------- import ----------------

    class UnsupportedFormatException(name: String) : IOException("Unsupported file: $name")

    @Throws(IOException::class)
    fun importUri(uri: Uri): Book {
        val resolver = context.contentResolver
        var name: String? = null
        var size = 0L
        if (uri.scheme == "content") {
            resolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (ni >= 0) name = c.getString(ni)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                }
            }
        }
        if (name == null) name = uri.lastPathSegment?.substringAfterLast('/')
        val mime = resolver.getType(uri)
        val stream = resolver.openInputStream(uri) ?: throw IOException("Cannot open $uri")
        return stream.use { importStream(it, name ?: "book", mime, null) }
    }

    @Throws(IOException::class)
    fun importStream(input: InputStream, displayName: String, mime: String?, sourceUrl: String?): Book {
        val format = Formats.detect(displayName, mime) ?: throw UnsupportedFormatException(displayName)
        val id = UUID.randomUUID().toString()
        val ext = if (format == "fbz") "fb2.zip" else format
        val fileName = "$id.$ext"
        val target = File(booksDir, fileName)
        val tmp = File(booksDir, "$fileName.part")
        try {
            FileOutputStream(tmp).use { out -> input.copyTo(out, 64 * 1024) }
            if (!tmp.renameTo(target)) throw IOException("Could not move file into library")
        } finally {
            tmp.delete()
        }
        val baseTitle = displayName.substringAfterLast('/').substringBeforeLast('.').replace('_', ' ').trim()
            .ifEmpty { "Untitled" }
        val book = Book(
            id = id, title = baseTitle, author = "", format = format, fileName = fileName,
            addedAt = System.currentTimeMillis(), sourceUrl = sourceUrl, sizeBytes = target.length(),
        )
        try {
            val meta = CoverExtractor.extract(target, format, coverFileFor(id))
            meta.title?.takeIf { it.isNotBlank() }?.let { book.title = it }
            meta.author?.takeIf { it.isNotBlank() }?.let { book.author = it }
            book.hasCover = meta.coverSaved
        } catch (e: Exception) {
            Log.w(TAG, "metadata extraction failed for $displayName", e)
        }
        save(book)
        return book
    }

    // ---------------- persistence ----------------

    private fun load(): MutableList<Book> {
        cache?.let { return it }
        val list = mutableListOf<Book>()
        if (indexFile.exists()) {
            try {
                val arr = JSONObject(indexFile.readText()).optJSONArray("books") ?: JSONArray()
                for (i in 0 until arr.length()) list.add(Book.fromJson(arr.getJSONObject(i)))
            } catch (e: Exception) {
                Log.e(TAG, "library index unreadable", e)
            }
        }
        cache = list
        return list
    }

    private fun persist(list: MutableList<Book>) {
        cache = list
        val arr = JSONArray()
        list.forEach { arr.put(it.toJson()) }
        val tmp = File(indexFile.parentFile, "library.json.tmp")
        tmp.writeText(JSONObject().put("version", 1).put("books", arr).toString())
        if (!tmp.renameTo(indexFile)) {
            indexFile.writeText(tmp.readText())
            tmp.delete()
        }
    }

    companion object {
        private const val TAG = "BookRepository"
    }
}
