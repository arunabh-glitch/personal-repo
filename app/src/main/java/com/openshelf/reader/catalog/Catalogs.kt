package com.openshelf.reader.catalog

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class Catalog(val name: String, val url: String, val builtIn: Boolean)

/** Built-in free catalogs plus user-added OPDS feeds. */
object Catalogs {
    val builtIn = listOf(
        Catalog("Project Gutenberg", "https://m.gutenberg.org/ebooks.opds/", true),
        Catalog("Standard Ebooks", "https://standardebooks.org/feeds/opds", true),
        Catalog("Feedbooks – Public Domain", "https://catalog.feedbooks.com/publicdomain/browse/top.atom", true),
        Catalog("Unglue.it", "https://unglue.it/api/opds/", true),
        Catalog("Internet Archive", "https://bookserver.archive.org/catalog/", true),
    )

    fun all(context: Context): List<Catalog> = builtIn + custom(context)

    fun custom(context: Context): List<Catalog> {
        val raw = prefs(context).getString("custom", "[]") ?: "[]"
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { arr.getJSONObject(it) }.map { Catalog(it.getString("name"), it.getString("url"), false) }
        }.getOrDefault(emptyList())
    }

    fun add(context: Context, name: String, url: String) {
        val list = custom(context).filter { it.url != url } + Catalog(name, url, false)
        save(context, list)
    }

    fun remove(context: Context, catalog: Catalog) = save(context, custom(context).filter { it.url != catalog.url })

    private fun save(context: Context, list: List<Catalog>) {
        val arr = JSONArray()
        list.forEach { arr.put(JSONObject().put("name", it.name).put("url", it.url)) }
        prefs(context).edit().putString("custom", arr.toString()).apply()
    }

    private fun prefs(context: Context) = context.getSharedPreferences("catalogs", Context.MODE_PRIVATE)
}
