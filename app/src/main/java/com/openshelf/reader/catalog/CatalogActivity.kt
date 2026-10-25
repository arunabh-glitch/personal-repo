package com.openshelf.reader.catalog

import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.openshelf.reader.R
import com.openshelf.reader.databinding.ActivityListBinding
import com.openshelf.reader.databinding.DialogUrlBinding

class CatalogActivity : AppCompatActivity() {
    private lateinit var binding: ActivityListBinding
    private lateinit var adapter: EntryAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityListBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        supportActionBar?.title = getString(R.string.catalogs)

        adapter = EntryAdapter(lifecycleScope,
            onClick = { row -> (row.payload as? Catalog)?.let { CatalogBrowseActivity.start(this, it.url, it.name) } },
            onLongClick = { row -> (row.payload as? Catalog)?.takeIf { !it.builtIn }?.let { confirmRemove(it) } })
        binding.recycler.layoutManager = LinearLayoutManager(this)
        binding.recycler.adapter = adapter
        binding.swipe.isEnabled = false
        binding.fab.visibility = View.VISIBLE
        binding.fab.setOnClickListener { showAddDialog() }
        refresh()
    }

    override fun onSupportNavigateUp(): Boolean { finish(); return true }

    private fun refresh() {
        adapter.submit(Catalogs.all(this).map {
            EntryAdapter.Row(it.name, if (it.builtIn) getString(R.string.built_in) else it.url, isNavigation = true, payload = it)
        })
    }

    private fun showAddDialog() {
        val vb = DialogUrlBinding.inflate(layoutInflater)
        vb.nameLayout.visibility = View.VISIBLE
        vb.url.hint = getString(R.string.catalog_url)
        AlertDialog.Builder(this).setTitle(R.string.add_catalog).setView(vb.root)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.ok) { _, _ ->
                val url = vb.url.text?.toString()?.trim().orEmpty()
                val name = vb.name.text?.toString()?.trim().orEmpty().ifEmpty { url.removePrefix("https://").removePrefix("http://").substringBefore('/') }
                if (url.startsWith("http")) { Catalogs.add(this, name, url); refresh() }
            }.show()
    }

    private fun confirmRemove(c: Catalog) {
        AlertDialog.Builder(this).setTitle(R.string.remove_catalog).setMessage(c.name)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.delete) { _, _ -> Catalogs.remove(this, c); refresh() }.show()
    }
}
