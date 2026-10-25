package com.openshelf.reader.catalog

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SearchView
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.snackbar.Snackbar
import com.openshelf.reader.OpenShelfApp
import com.openshelf.reader.R
import com.openshelf.reader.data.Formats
import com.openshelf.reader.databinding.ActivityListBinding
import com.openshelf.reader.reader.ReaderActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class CatalogBrowseActivity : AppCompatActivity() {
    private lateinit var binding: ActivityListBinding
    private lateinit var adapter: EntryAdapter
    private lateinit var url: String
    private var feed: OpdsFeed? = null
    private var nextUrl: String? = null
    private var loadingMore = false
    private var searchTemplate: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityListBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        url = intent.getStringExtra(EXTRA_URL) ?: run { finish(); return }
        supportActionBar?.title = intent.getStringExtra(EXTRA_TITLE) ?: getString(R.string.catalogs)
        searchTemplate = intent.getStringExtra(EXTRA_SEARCH)

        adapter = EntryAdapter(lifecycleScope, onClick = { row -> (row.payload as? OpdsEntry)?.let { onEntry(it) } })
        val lm = LinearLayoutManager(this)
        binding.recycler.layoutManager = lm
        binding.recycler.adapter = adapter
        binding.recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                if (dy > 0 && nextUrl != null && !loadingMore && lm.findLastVisibleItemPosition() >= adapter.itemCount - 6) loadMore()
            }
        })
        binding.swipe.setOnRefreshListener { load() }
        load()
    }

    override fun onSupportNavigateUp(): Boolean { finish(); return true }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_browse, menu)
        val item = menu.findItem(R.id.action_search)
        item.isVisible = searchTemplate != null
        (item.actionView as? SearchView)?.apply {
            queryHint = getString(R.string.search_hint)
            setOnQueryTextListener(object : SearchView.OnQueryTextListener {
                override fun onQueryTextSubmit(q: String): Boolean {
                    val t = searchTemplate ?: return false
                    start(this@CatalogBrowseActivity, Opds.searchUrl(t, q), "“$q”", t)
                    clearFocus()
                    return true
                }
                override fun onQueryTextChange(newText: String) = false
            })
        }
        return true
    }

    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        menu.findItem(R.id.action_search)?.isVisible = searchTemplate != null
        return super.onPrepareOptionsMenu(menu)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        R.id.action_open_browser -> { runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }; true }
        else -> super.onOptionsItemSelected(item)
    }

    private fun load() {
        binding.swipe.isRefreshing = true
        binding.empty.visibility = View.GONE
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val f = Opds.fetch(url)
                    val search = searchTemplate ?: runCatching { Opds.resolveSearch(f) }.getOrNull()
                    f to search
                }
            }
            binding.swipe.isRefreshing = false
            result.onSuccess { (f, search) ->
                feed = f
                nextUrl = f.next
                if (search != null && searchTemplate == null) { searchTemplate = search; invalidateOptionsMenu() }
                if (f.title.isNotBlank() && intent.getStringExtra(EXTRA_TITLE) == null) supportActionBar?.title = f.title
                adapter.submit(f.entries.map { toRow(it) })
                if (f.entries.isEmpty()) { binding.empty.text = getString(R.string.no_results); binding.empty.visibility = View.VISIBLE }
            }.onFailure { e ->
                binding.empty.text = getString(R.string.load_failed, e.message ?: e.javaClass.simpleName)
                binding.empty.visibility = View.VISIBLE
                Snackbar.make(binding.root, getString(R.string.load_failed, e.message ?: ""), Snackbar.LENGTH_LONG)
                    .setAction(R.string.retry) { load() }.show()
            }
        }
    }

    private fun loadMore() {
        val next = nextUrl ?: return
        loadingMore = true
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { Opds.fetch(next) } }
            loadingMore = false
            result.onSuccess { f -> nextUrl = f.next; adapter.append(f.entries.map { toRow(it) }) }
                .onFailure { nextUrl = null }
        }
    }

    private fun toRow(e: OpdsEntry): EntryAdapter.Row {
        val sub = if (e.isNavigation) e.summary?.take(120)
        else listOfNotNull(e.authors.joinToString(", ").ifBlank { null }, EntryAdapter.formatsLabel(e).ifBlank { null }).joinToString(" · ")
        return EntryAdapter.Row(e.title, sub, e.isNavigation, e.thumbnail, e)
    }

    private fun onEntry(e: OpdsEntry) {
        if (e.isNavigation) {
            start(this, e.navLink!!.href, e.title, searchTemplate)
            return
        }
        val downloads = e.downloads
        if (downloads.isEmpty()) {
            val alt = e.links.firstOrNull { it.rel == "alternate" && it.type?.contains("html") == true }
            if (alt != null) runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(alt.href))) }
            else Snackbar.make(binding.root, R.string.no_results, Snackbar.LENGTH_SHORT).show()
            return
        }
        if (downloads.size == 1) download(e, downloads[0])
        else {
            val labels = downloads.map { Formats.label(Formats.fromMime(it.type) ?: "?") + (it.title?.let { t -> " – $t" } ?: "") }.toTypedArray()
            AlertDialog.Builder(this).setTitle(e.title).setItems(labels) { _, i -> download(e, downloads[i]) }.show()
        }
    }

    private fun download(e: OpdsEntry, link: OpdsLink) {
        val repo = OpenShelfApp.repo(application)
        val snack = Snackbar.make(binding.root, getString(R.string.downloading), Snackbar.LENGTH_INDEFINITE).also { it.show() }
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { Downloader.download(repo, link.href, e.title, link.type) } }
            snack.dismiss()
            result.onSuccess { book ->
                if (book.author.isBlank() && e.authors.isNotEmpty()) { book.author = e.authors.joinToString(", "); repo.save(book) }
                Snackbar.make(binding.root, getString(R.string.downloaded, book.title), Snackbar.LENGTH_LONG)
                    .setAction(android.R.string.ok) { ReaderActivity.start(this@CatalogBrowseActivity, book.id) }.show()
            }.onFailure { err ->
                Snackbar.make(binding.root, getString(R.string.download_failed, err.message ?: err.javaClass.simpleName), Snackbar.LENGTH_LONG).show()
            }
        }
    }

    companion object {
        private const val EXTRA_URL = "url"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_SEARCH = "search"

        fun start(context: Context, url: String, title: String?, searchTemplate: String? = null) {
            context.startActivity(Intent(context, CatalogBrowseActivity::class.java)
                .putExtra(EXTRA_URL, url).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_SEARCH, searchTemplate))
        }
    }
}
