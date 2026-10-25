package com.openshelf.reader.catalog

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.widget.ImageViewCompat
import androidx.recyclerview.widget.RecyclerView
import com.openshelf.reader.R
import com.openshelf.reader.data.Formats
import com.openshelf.reader.databinding.ItemEntryBinding
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Generic row: used for catalogs (navigation) and OPDS entries. */
class EntryAdapter(
    private val scope: CoroutineScope,
    private val onClick: (Row) -> Unit,
    private val onLongClick: ((Row) -> Unit)? = null,
) : RecyclerView.Adapter<EntryAdapter.VH>() {

    data class Row(
        val title: String,
        val subtitle: String?,
        val isNavigation: Boolean,
        val thumbnail: String? = null,
        val payload: Any? = null,
    )

    private val rows = mutableListOf<Row>()

    fun submit(list: List<Row>) { rows.clear(); rows.addAll(list); notifyDataSetChanged() }
    fun append(list: List<Row>) { val start = rows.size; rows.addAll(list); notifyItemRangeInserted(start, list.size) }
    fun items(): List<Row> = rows

    inner class VH(val b: ItemEntryBinding) : RecyclerView.ViewHolder(b.root) { var job: Job? = null }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        VH(ItemEntryBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun getItemCount() = rows.size

    override fun onBindViewHolder(holder: VH, position: Int) {
        val row = rows[position]
        val b = holder.b
        b.title.text = row.title
        b.subtitle.text = row.subtitle
        b.subtitle.visibility = if (row.subtitle.isNullOrBlank()) View.GONE else View.VISIBLE
        b.chevron.visibility = if (row.isNavigation) View.VISIBLE else View.GONE
        holder.job?.cancel()
        val tintList = b.icon.context.getColorStateList(R.color.primary)
        ImageViewCompat.setImageTintList(b.icon, tintList)
        b.icon.setImageResource(if (row.isNavigation) R.drawable.ic_folder else R.drawable.ic_book)
        if (!row.isNavigation && row.thumbnail != null) {
            val url = row.thumbnail
            cache.get(url)?.let { ImageViewCompat.setImageTintList(b.icon, null); b.icon.setImageBitmap(it) } ?: run {
                holder.job = scope.launch {
                    val bmp = withContext(Dispatchers.IO) { loadThumb(url) }
                    if (bmp != null && holder.bindingAdapterPosition == position) {
                        ImageViewCompat.setImageTintList(b.icon, null)
                        b.icon.setImageBitmap(bmp)
                    }
                }
            }
        }
        b.root.setOnClickListener { onClick(row) }
        b.root.setOnLongClickListener { onLongClick?.invoke(row); onLongClick != null }
    }

    override fun onViewRecycled(holder: VH) { holder.job?.cancel(); super.onViewRecycled(holder) }

    private fun loadThumb(url: String): Bitmap? = runCatching {
        val (_, stream) = Opds.open(url, accept = "image/*,*/*;q=0.8")
        val bytes = stream.use { it.readBytes() }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (bounds.outHeight / sample > 240) sample *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }.getOrNull()?.also { cache.put(url, it) }

    companion object {
        private val cache = LruCache<String, Bitmap>(60)

        fun formatsLabel(entry: OpdsEntry): String =
            entry.downloads.mapNotNull { Formats.fromMime(it.type) }.map { Formats.label(it) }.distinct().joinToString(", ")
    }
}
