package com.openshelf.reader

import android.app.Application
import com.openshelf.reader.data.BookRepository

class OpenShelfApp : Application() {
    lateinit var repository: BookRepository
        private set

    override fun onCreate() {
        super.onCreate()
        repository = BookRepository(this)
    }

    companion object {
        fun repo(app: Application): BookRepository = (app as OpenShelfApp).repository
    }
}
