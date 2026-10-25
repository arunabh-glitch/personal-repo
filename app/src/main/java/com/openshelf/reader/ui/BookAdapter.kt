package com.openshelf.reader.ui

import android.graphics.BitmapFactory
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.openshelf.reader.R
import com.openshelf.reader.data.Book
import com.openshelf.reader.data.BookRepository
import com.openshelf.reader.data.Formats
import com.openshelf.reader.databinding.ItemBookBinding
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class BookAdapter(
    private val repo: BookRepository,
    private val scope: CoroutineScope,
    private val onClick: (Book) -> Unit,
    private val onLongClick: (Book) -> Unit,
) : ListAdapter<Book, BookAdapter.VH>(DIFF) {

    inner class VH(val b: ItemBookBinding) : RecyclerView.ViewHolder(b.root) {
        var job: Job? = null
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val b = ItemBookBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        // Covers are 2:3; size the image from the column width so the grid is uniform.
        val span = (parent as? RecyclerView)?.layoutManager?.let { (it as? androidx.recyclerview.widget.GridLayoutManager)?.spanCount } ?: 3
        val padding = (16 * parent.resources.displayMetrics.density).toInt()
        val colWidth = (parent.width - parent.paddingLeft - parent.paddingRight) / span - padding
        if (colWidth > 0) b.cover.layoutParams.height = colWidth * 3 / 2
        else b.cover.layoutParams.height = (180 * parent.resources.displayMetrics.density).toInt()
        return VH(b)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val book = getItem(position)
        val b = holder.b
        val ctx = b.root.context
        b.title.text = book.title
        b.author.text = book.author.ifBlank { Formats.label(book.format) }
        val pct = (book.progress * 100).toInt()
        b.badge.text = if (pct > 0) ctx.getString(R.string.progress_percent, pct) else Formats.label(book.format)
        b.badge.visibility = View.VISIBLE
        b.cover.setImageResource(R.drawable.cover_placeholder)
        holder.job?.cancel()
        val coverFile = repo.coverFor(book)
        if (coverFile != null) {
            holder.job = scope.launch {
                val bmp = withContext(Dispatchers.IO) {
                    runCatching { BitmapFactory.decodeFile(coverFile.absolutePath) }.getOrNull()
                }
                if (bmp != null && holder.bindingAdapterPosition != RecyclerView.NO_POSITION &&
                    getItem(holder.bindingAdapterPosition).id == book.id) b.cover.setImageBitmap(bmp)
            }
        }
        b.root.setOnClickListener { onClick(book) }
        b.root.setOnLongClickListener { onLongClick(book); true }
    }

    override fun onViewRecycled(holder: VH) {
        holder.job?.cancel()
        super.onViewRecycled(holder)
    }

    companion object {
        val DIFF = object : DiffUtil.ItemCallback<Book>() {
            override fun areItemsTheSame(a: Book, b: Book) = a.id == b.id
            override fun areContentsTheSame(a: Book, b: Book) = a == b
        }
    }
}
