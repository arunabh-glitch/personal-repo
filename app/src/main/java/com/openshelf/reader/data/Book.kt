package com.openshelf.reader.data

import org.json.JSONObject

data class Book(
    val id: String,
    var title: String,
    var author: String,
    val format: String,
    val fileName: String,
    val addedAt: Long,
    var lastOpenedAt: Long = 0L,
    var progress: Double = 0.0,
    var location: String? = null,
    var progressLabel: String? = null,
    var hasCover: Boolean = false,
    var sourceUrl: String? = null,
    var metadataFetched: Boolean = false,
    var sizeBytes: Long = 0L,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("title", title); put("author", author); put("format", format)
        put("fileName", fileName); put("addedAt", addedAt); put("lastOpenedAt", lastOpenedAt)
        put("progress", progress); put("location", location ?: JSONObject.NULL)
        put("progressLabel", progressLabel ?: JSONObject.NULL); put("hasCover", hasCover)
        put("sourceUrl", sourceUrl ?: JSONObject.NULL); put("metadataFetched", metadataFetched)
        put("sizeBytes", sizeBytes)
    }

    companion object {
        fun fromJson(o: JSONObject): Book = Book(
            id = o.getString("id"),
            title = o.optString("title", ""),
            author = o.optString("author", ""),
            format = o.getString("format"),
            fileName = o.getString("fileName"),
            addedAt = o.optLong("addedAt", 0L),
            lastOpenedAt = o.optLong("lastOpenedAt", 0L),
            progress = o.optDouble("progress", 0.0),
            location = o.optString("location", "").ifEmpty { null },
            progressLabel = o.optString("progressLabel", "").ifEmpty { null },
            hasCover = o.optBoolean("hasCover", false),
            sourceUrl = o.optString("sourceUrl", "").ifEmpty { null },
            metadataFetched = o.optBoolean("metadataFetched", false),
            sizeBytes = o.optLong("sizeBytes", 0L),
        )
    }
}
