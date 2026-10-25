package com.openshelf.reader.data

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.util.Xml
import org.xmlpull.v1.XmlPullParser
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.zip.ZipFile

/**
 * Best-effort native metadata/cover extraction at import time, so the library
 * looks right before the book is first opened. The web reader refines it later.
 */
object CoverExtractor {
    data class Meta(val title: String? = null, val author: String? = null, val coverSaved: Boolean = false)

    private const val MAX_COVER_HEIGHT = 640

    fun extract(file: File, format: String, coverOut: File): Meta = when (format) {
        "epub" -> fromEpub(file, coverOut)
        "pdf" -> fromPdf(file, coverOut)
        "cbz" -> fromCbz(file, coverOut)
        else -> Meta()
    }

    // ---------- EPUB ----------
    private fun fromEpub(file: File, coverOut: File): Meta {
        ZipFile(file).use { zip ->
            val container = zip.getEntry("META-INF/container.xml") ?: return Meta()
            var opfPath: String? = null
            zip.getInputStream(container).use { s ->
                val p = newParser(s)
                while (p.next() != XmlPullParser.END_DOCUMENT) {
                    if (p.eventType == XmlPullParser.START_TAG && p.name == "rootfile") {
                        opfPath = p.getAttributeValue(null, "full-path"); break
                    }
                }
            }
            val opf = opfPath?.let { zip.getEntry(it) } ?: return Meta()
            val opfDir = opfPath!!.substringBeforeLast('/', "").let { if (it.isEmpty()) "" else "$it/" }

            var title: String? = null
            var author: String? = null
            var coverMetaId: String? = null
            var coverHref: String? = null
            val manifest = mutableMapOf<String, String>()
            zip.getInputStream(opf).use { s ->
                val p = newParser(s)
                while (p.next() != XmlPullParser.END_DOCUMENT) {
                    if (p.eventType != XmlPullParser.START_TAG) continue
                    when (p.name) {
                        "title" -> if (title == null) title = p.nextText().trim()
                        "creator" -> if (author == null) author = p.nextText().trim()
                        "meta" -> if (p.getAttributeValue(null, "name") == "cover")
                            coverMetaId = p.getAttributeValue(null, "content")
                        "item" -> {
                            val id = p.getAttributeValue(null, "id") ?: continue
                            val href = p.getAttributeValue(null, "href") ?: continue
                            val props = p.getAttributeValue(null, "properties") ?: ""
                            val type = p.getAttributeValue(null, "media-type") ?: ""
                            manifest[id] = href
                            if (props.split(' ').contains("cover-image")) coverHref = href
                            else if (coverHref == null && id.equals("cover", true) && type.startsWith("image/")) coverHref = href
                        }
                    }
                }
            }
            if (coverHref == null && coverMetaId != null) coverHref = manifest[coverMetaId]
            var saved = false
            coverHref?.let { href ->
                val path = normalize(opfDir + href.substringBefore('#'))
                val entry = zip.getEntry(path) ?: zip.getEntry(java.net.URLDecoder.decode(path, "UTF-8"))
                if (entry != null) saved = saveScaled({ zip.getInputStream(entry) }, coverOut)
            }
            return Meta(title, author, saved)
        }
    }

    // ---------- PDF ----------
    private fun fromPdf(file: File, coverOut: File): Meta {
        ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { pfd ->
            PdfRenderer(pfd).use { renderer ->
                if (renderer.pageCount == 0) return Meta()
                renderer.openPage(0).use { page ->
                    val width = 400
                    val height = (width.toFloat() * page.height / page.width).toInt().coerceAtLeast(1)
                    val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                    Canvas(bmp).drawColor(Color.WHITE)
                    page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    FileOutputStream(coverOut).use { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }
                    bmp.recycle()
                }
            }
        }
        return Meta(coverSaved = true)
    }

    // ---------- CBZ ----------
    private fun fromCbz(file: File, coverOut: File): Meta {
        ZipFile(file).use { zip ->
            val exts = listOf(".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp")
            val first = zip.entries().asSequence()
                .filter { !it.isDirectory && exts.any { e -> it.name.lowercase().endsWith(e) } }
                .map { it.name }.sorted().firstOrNull() ?: return Meta()
            val entry = zip.getEntry(first)
            return Meta(coverSaved = saveScaled({ zip.getInputStream(entry) }, coverOut))
        }
    }

    // ---------- helpers ----------
    private fun newParser(s: InputStream): XmlPullParser = Xml.newPullParser().apply {
        setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
        setInput(s, null)
    }

    private fun normalize(path: String): String {
        val parts = ArrayDeque<String>()
        for (seg in path.split('/')) when (seg) {
            "", "." -> {}
            ".." -> parts.removeLastOrNull()
            else -> parts.addLast(seg)
        }
        return parts.joinToString("/")
    }

    private fun saveScaled(open: () -> InputStream, out: File): Boolean {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        open().use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outHeight <= 0) return false
        var sample = 1
        while (bounds.outHeight / sample > MAX_COVER_HEIGHT * 2) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        val bmp = open().use { BitmapFactory.decodeStream(it, null, opts) } ?: return false
        val scaled = if (bmp.height > MAX_COVER_HEIGHT) {
            val w = (bmp.width.toFloat() * MAX_COVER_HEIGHT / bmp.height).toInt().coerceAtLeast(1)
            Bitmap.createScaledBitmap(bmp, w, MAX_COVER_HEIGHT, true)
        } else bmp
        FileOutputStream(out).use { scaled.compress(Bitmap.CompressFormat.JPEG, 85, it) }
        if (scaled !== bmp) scaled.recycle()
        bmp.recycle()
        return true
    }
}
