package com.openshelf.reader.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.IntentCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import com.google.android.material.snackbar.Snackbar
import com.openshelf.reader.OpenShelfApp
import com.openshelf.reader.R
import com.openshelf.reader.catalog.CatalogActivity
import com.openshelf.reader.catalog.Downloader
import com.openshelf.reader.data.Book
import com.openshelf.reader.data.BookRepository
import com.openshelf.reader.data.Formats
import com.openshelf.reader.databinding.ActivityMainBinding
import com.openshelf.reader.databinding.DialogUrlBinding
import com.openshelf.reader.reader.ReaderActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var repo: BookRepository
    private lateinit var adapter: BookAdapter

    private val pickFiles = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) importUris(uris, openWhenSingle = false)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)
        repo = OpenShelfApp.repo(application)

        adapter = BookAdapter(repo, lifecycleScope, onClick = { ReaderActivity.start(this, it.id) }, onLongClick = { showBookMenu(it) })
        val span = (resources.displayMetrics.widthPixels / (resources.displayMetrics.density * 120)).toInt().coerceIn(2, 6)
        binding.recycler.layoutManager = GridLayoutManager(this, span)
        binding.recycler.adapter = adapter
        binding.fab.setOnClickListener { pickFiles.launch(arrayOf("*/*")) }

        if (savedInstanceState == null) handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        val books = repo.all()
        val sorted = when (prefs().getString(KEY_SORT, SORT_RECENT)) {
            SORT_TITLE -> books.sortedBy { it.title.lowercase() }
            SORT_AUTHOR -> books.sortedWith(compareBy({ it.author.lowercase() }, { it.title.lowercase() }))
            SORT_ADDED -> books.sortedByDescending { it.addedAt }
            else -> books.sortedByDescending { maxOf(it.lastOpenedAt, it.addedAt) }
        }
        adapter.submitList(sorted)
        binding.empty.visibility = if (sorted.isEmpty()) View.VISIBLE else View.GONE
    }

    // ---------------- intents (open with / share) ----------------

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        when (intent.action) {
            Intent.ACTION_VIEW -> intent.data?.let { importUris(listOf(it), openWhenSingle = true) }
            Intent.ACTION_SEND -> IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                ?.let { importUris(listOf(it), openWhenSingle = true) }
            Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                ?.let { importUris(it, openWhenSingle = false) }
        }
        intent.action = null
    }

    private fun importUris(uris: List<Uri>, openWhenSingle: Boolean) {
        binding.progress.visibility = View.VISIBLE
        lifecycleScope.launch {
            val imported = mutableListOf<Book>()
            val failures = mutableListOf<String>()
            withContext(Dispatchers.IO) {
                for (uri in uris) {
                    try {
                        runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                        imported += repo.importUri(uri)
                    } catch (e: BookRepository.UnsupportedFormatException) {
                        failures += getString(R.string.unsupported_file, uri.lastPathSegment ?: uri.toString())
                    } catch (e: Exception) {
                        failures += getString(R.string.import_failed, uri.lastPathSegment ?: uri.toString())
                    }
                }
            }
            binding.progress.visibility = View.GONE
            refresh()
            if (failures.isNotEmpty()) Snackbar.make(binding.root, failures.first(), Snackbar.LENGTH_LONG).show()
            else if (imported.isNotEmpty()) Snackbar.make(binding.root, getString(R.string.imported_n, imported.size), Snackbar.LENGTH_SHORT).show()
            if (openWhenSingle && imported.size == 1) ReaderActivity.start(this@MainActivity, imported[0].id)
        }
    }

    // ---------------- menu ----------------

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        R.id.action_catalogs -> { startActivity(Intent(this, CatalogActivity::class.java)); true }
        R.id.action_url -> { showUrlDialog(); true }
        R.id.action_sort -> { showSortDialog(); true }
        else -> super.onOptionsItemSelected(item)
    }

    private fun showSortDialog() {
        val keys = arrayOf(SORT_RECENT, SORT_TITLE, SORT_AUTHOR, SORT_ADDED)
        val labels = arrayOf(getString(R.string.sort_recent), getString(R.string.sort_title), getString(R.string.sort_author), getString(R.string.sort_added))
        val current = keys.indexOf(prefs().getString(KEY_SORT, SORT_RECENT)).coerceAtLeast(0)
        AlertDialog.Builder(this).setTitle(R.string.sort)
            .setSingleChoiceItems(labels, current) { d, which ->
                prefs().edit().putString(KEY_SORT, keys[which]).apply()
                refresh(); d.dismiss()
            }.show()
    }

    private fun showUrlDialog() {
        val vb = DialogUrlBinding.inflate(layoutInflater)
        vb.url.setHint(R.string.url_hint)
        AlertDialog.Builder(this).setTitle(R.string.download_from_url).setView(vb.root)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.download) { _, _ ->
                val url = vb.url.text?.toString()?.trim().orEmpty()
                if (url.isNotEmpty()) downloadUrl(url)
            }.show()
    }

    private fun downloadUrl(url: String) {
        binding.progress.visibility = View.VISIBLE
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { Downloader.download(repo, url, null, null) } }
            binding.progress.visibility = View.GONE
            refresh()
            result.onSuccess { book ->
                Snackbar.make(binding.root, getString(R.string.downloaded, book.title), Snackbar.LENGTH_LONG)
                    .setAction(android.R.string.ok) { ReaderActivity.start(this@MainActivity, book.id) }.show()
            }.onFailure { e ->
                Snackbar.make(binding.root, getString(R.string.download_failed, e.message ?: e.javaClass.simpleName), Snackbar.LENGTH_LONG).show()
            }
        }
    }

    // ---------------- per-book actions ----------------

    private fun showBookMenu(book: Book) {
        val items = arrayOf(getString(R.string.details), getString(R.string.delete))
        AlertDialog.Builder(this).setTitle(book.title).setItems(items) { _, which ->
            when (which) {
                0 -> showDetails(book)
                1 -> confirmDelete(book)
            }
        }.show()
    }

    private fun showDetails(book: Book) {
        val df = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
        val size = if (book.sizeBytes > 0) "%.1f MB".format(book.sizeBytes / 1048576.0) else "–"
        val msg = buildString {
            append(getString(R.string.unknown_author).takeIf { book.author.isBlank() } ?: book.author).append('\n')
            append(Formats.label(book.format)).append(" · ").append(size).append('\n')
            append(book.progressLabel ?: getString(R.string.not_started)).append(" (").append((book.progress * 100).toInt()).append("%)\n")
            append(df.format(Date(book.addedAt)))
            book.sourceUrl?.let { append('\n').append(it) }
        }
        AlertDialog.Builder(this).setTitle(book.title).setMessage(msg).setPositiveButton(R.string.ok, null).show()
    }

    private fun confirmDelete(book: Book) {
        AlertDialog.Builder(this).setTitle(R.string.delete_book_title)
            .setMessage(getString(R.string.delete_book_message, book.title))
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.delete) { _, _ ->
                lifecycleScope.launch {
                    withContext(Dispatchers.IO) { repo.delete(book) }
                    refresh()
                }
            }.show()
    }

    private fun prefs() = getSharedPreferences("library", Context.MODE_PRIVATE)

    companion object {
        private const val KEY_SORT = "sort"
        private const val SORT_RECENT = "recent"
        private const val SORT_TITLE = "title"
        private const val SORT_AUTHOR = "author"
        private const val SORT_ADDED = "added"
    }
}
