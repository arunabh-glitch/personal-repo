package com.openshelf.reader.catalog

import android.util.Xml
import com.openshelf.reader.data.Formats
import org.xmlpull.v1.XmlPullParser
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class OpdsLink(val href: String, val rel: String?, val type: String?, val title: String?) {
    val isAcquisition: Boolean get() = rel != null && rel.startsWith("http://opds-spec.org/acquisition")
    /** Direct downloads only: skip buy/borrow/subscribe/sample links. */
    val isOpenAcquisition: Boolean get() = isAcquisition &&
        !rel!!.endsWith("/buy") && !rel.endsWith("/borrow") && !rel.endsWith("/subscribe") && !rel.endsWith("/sample")
    val isNavigation: Boolean get() = type != null && type.contains("atom+xml") && !isAcquisition
    val isImage: Boolean get() = rel != null && (rel.contains("image") || rel.contains("thumbnail") || type?.startsWith("image/") == true)
}

data class OpdsEntry(
    val id: String,
    val title: String,
    val authors: List<String>,
    val summary: String?,
    val links: List<OpdsLink>,
) {
    val downloads: List<OpdsLink> get() = links.filter { it.isOpenAcquisition && Formats.isReadableMime(it.type) }
    val navLink: OpdsLink? get() = links.firstOrNull { it.isNavigation }
        ?: links.firstOrNull { it.isAcquisition.not() && it.rel in setOf("subsection", "alternate", null) && it.type?.contains("xml") == true }
    val thumbnail: String? get() = (links.firstOrNull { it.rel?.endsWith("image/thumbnail") == true }
        ?: links.firstOrNull { it.isImage })?.href
    val isNavigation: Boolean get() = downloads.isEmpty() && navLink != null
}

data class OpdsFeed(
    val title: String,
    val entries: List<OpdsEntry>,
    val next: String?,
    val searchTemplate: String?,
)

object Opds {
    private const val UA = "OpenShelf/1.0 (Android; OPDS client)"

    @Throws(IOException::class)
    fun fetch(url: String): OpdsFeed {
        val (finalUrl, stream) = open(url)
        return stream.use { parse(it, finalUrl) }
    }

    /** Resolve an OpenSearch description into a template with {searchTerms}. */
    @Throws(IOException::class)
    fun resolveSearch(feed: OpdsFeed): String? {
        val t = feed.searchTemplate ?: return null
        if (t.contains("{searchTerms}")) return t
        // It's an OpenSearch description document.
        val (base, stream) = open(t)
        stream.use { s ->
            val p = newParser(s)
            var fallback: String? = null
            while (p.next() != XmlPullParser.END_DOCUMENT) {
                if (p.eventType == XmlPullParser.START_TAG && p.name == "Url") {
                    val type = p.getAttributeValue(null, "type") ?: ""
                    val template = p.getAttributeValue(null, "template") ?: continue
                    val abs = resolve(base, template)
                    if (type.contains("atom") || type.contains("opds")) return abs
                    if (fallback == null) fallback = abs
                }
            }
            return fallback
        }
    }

    fun searchUrl(template: String, query: String): String =
        template.replace("{searchTerms}", URLEncoder.encode(query, "UTF-8"))
            .replace(Regex("\\{[^}]*\\?\\}"), "") // drop optional params
            .replace(Regex("\\{[^}]*\\}"), "")

    @Throws(IOException::class)
    fun open(url: String, accept: String = "application/atom+xml;profile=opds-catalog, application/atom+xml, application/xml;q=0.9, */*;q=0.8"): Pair<String, InputStream> {
        var current = url
        repeat(8) {
            val conn = (URL(current).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = 20_000
                readTimeout = 30_000
                setRequestProperty("User-Agent", UA)
                setRequestProperty("Accept", accept)
            }
            val code = conn.responseCode
            if (code in 300..399) {
                val loc = conn.getHeaderField("Location") ?: throw IOException("Redirect without location")
                conn.disconnect()
                current = resolve(current, loc)
                return@repeat
            }
            if (code >= 400) {
                conn.disconnect()
                throw IOException("HTTP $code")
            }
            return current to conn.inputStream
        }
        throw IOException("Too many redirects")
    }

    fun resolve(base: String, href: String): String =
        runCatching { URL(URL(base), href).toString() }.getOrDefault(href)

    private fun newParser(s: InputStream): XmlPullParser = Xml.newPullParser().apply {
        setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
        setInput(s, null)
    }

    @Throws(IOException::class)
    fun parse(stream: InputStream, baseUrl: String): OpdsFeed {
        val p = newParser(stream)
        var feedTitle = ""
        var next: String? = null
        var search: String? = null
        val entries = mutableListOf<OpdsEntry>()

        var inEntry = false
        var id = ""; var title = ""; var summary: String? = null
        val authors = mutableListOf<String>(); val links = mutableListOf<OpdsLink>()
        var inAuthor = false
        var depth = 0

        var event = p.eventType
        while (event != XmlPullParser.END_DOCUMENT) {
            when (event) {
                XmlPullParser.START_TAG -> {
                    depth++
                    when (p.name) {
                        "entry" -> { inEntry = true; id = ""; title = ""; summary = null; authors.clear(); links.clear() }
                        "author" -> if (inEntry) inAuthor = true
                        "name" -> if (inEntry && inAuthor) authors.add(p.nextText().trim()).also { depth-- }
                        "title" -> {
                            val t = textOf(p); depth--
                            if (inEntry) title = t else if (depth <= 1 && feedTitle.isEmpty()) feedTitle = t
                        }
                        "id" -> if (inEntry) { id = p.nextText().trim(); depth-- }
                        "summary", "content" -> if (inEntry && summary == null) { summary = textOf(p).trim().take(600); depth-- }
                        "link" -> {
                            val href = p.getAttributeValue(null, "href")
                            val rel = p.getAttributeValue(null, "rel")
                            val type = p.getAttributeValue(null, "type")
                            val ltitle = p.getAttributeValue(null, "title")
                            if (href != null) {
                                val abs = resolve(baseUrl, href)
                                if (inEntry) links.add(OpdsLink(abs, rel, type, ltitle))
                                else when {
                                    rel == "next" -> next = abs
                                    rel == "search" -> if (search == null || type?.contains("opensearch") == true) search = abs
                                }
                            }
                        }
                    }
                }
                XmlPullParser.END_TAG -> {
                    depth--
                    when (p.name) {
                        "author" -> inAuthor = false
                        "entry" -> {
                            inEntry = false
                            if (title.isNotEmpty() || links.isNotEmpty())
                                entries.add(OpdsEntry(id.ifEmpty { title }, title.ifEmpty { "Untitled" }, authors.toList(), summary, links.toList()))
                        }
                    }
                }
            }
            event = p.next()
        }
        return OpdsFeed(feedTitle, entries, next, search)
    }

    /** Reads text content, flattening any inline XHTML (atom type="xhtml"/"html"). */
    private fun textOf(p: XmlPullParser): String {
        val sb = StringBuilder()
        var d = 1
        while (d > 0) {
            when (p.next()) {
                XmlPullParser.START_TAG -> { d++; if (p.name == "p" || p.name == "br") sb.append(' ') }
                XmlPullParser.END_TAG -> d--
                XmlPullParser.TEXT, XmlPullParser.CDSECT -> sb.append(p.text)
                XmlPullParser.END_DOCUMENT -> return sb.toString()
            }
        }
        val raw = sb.toString()
        // Strip HTML tags for type="html" summaries.
        return android.text.Html.fromHtml(raw.replace(Regex("\\s+"), " "), android.text.Html.FROM_HTML_MODE_COMPACT).toString()
    }
}
