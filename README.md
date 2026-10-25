# OpenShelf

An Android e-book reader. Open books from anywhere on your phone or from free online catalogs, and pick up where you left off.

**Formats:** EPUB (2 and 3, including fixed layout), PDF, MOBI, AZW / AZW3 (KF8), FB2 / FB2.zip, CBZ comics, plain text, Markdown and HTML.

**Sources**
- Import from any file manager or cloud drive via the system file picker (multi-select).
- "Open with" / "Share to OpenShelf" from other apps (mail attachments, browsers, Telegram, Drive…).
- Built-in OPDS catalogs: Project Gutenberg, Standard Ebooks, Feedbooks, Unglue.it, Internet Archive — browse, search and download straight into the library.
- Add your own OPDS catalog (Calibre-Web, Kavita, Komga, Calibre content server, …).
- Download a book from a direct URL.

**Reader**
- Pagination or continuous scroll, swipe or tap zones (left = back, right = forward, centre = menu).
- Themes (light, sepia, dusk, dark), text size, line spacing, margins, font family, justification.
- Table of contents, in-book search, progress slider, chapter/page indicator.
- PDF: continuous scroll, pinch and double-tap zoom, outline, text search, night mode filter.
- Reading position, covers and metadata are saved per book.

## Get the APK

Every push builds the app on GitHub Actions. Open the **Actions** tab, pick the latest *Build APK* run, and download the `OpenShelf-apk` artifact. It contains:

- `OpenShelf-debug.apk` – installable debug build.
- `OpenShelf-release.apk` – release build. It is signed with the debug key unless you add release signing secrets (see below).

Pushing a tag such as `v1.0.0` also attaches the APKs to a GitHub Release.

Install by copying the APK to your phone and opening it (allow "install unknown apps" for your file manager or browser when asked).

### Release signing (optional)

Add these repository secrets and the workflow signs the release APK with your key:

| Secret | Value |
| --- | --- |
| `KEYSTORE_BASE64` | `base64 -w0 my-release.jks` |
| `KEYSTORE_PASSWORD` | keystore password |
| `KEY_ALIAS` | key alias |
| `KEY_PASSWORD` | key password |

## Build locally

Requirements: JDK 17, Android SDK (API 35) — Android Studio installs both.

```bash
./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

## How it works

- **Kotlin app** (`app/src/main/java`): library grid, importer (Storage Access Framework + intent filters), OPDS client, downloader, and a full-screen `WebView` host for the reader.
- **Reader** (`app/src/main/assets/reader`): a self-contained web app rendered inside the WebView.
  - [foliate-js](https://github.com/johnfactotum/foliate-js) renders EPUB, MOBI, AZW3, FB2 and CBZ.
  - [pdf.js](https://mozilla.github.io/pdf.js/) renders PDF (`pdf-viewer.js`).
  - `text-book.js` adapts TXT / Markdown / HTML to the same reader.
  - Books are served to the page through `WebViewAssetLoader` (no file:// access, strict CSP, no scripts from book content).
- Library metadata and reading progress live in `files/library.json`; books and covers in the app's private storage.

## Project layout

```
app/src/main/java/com/openshelf/reader/
  data/      Book model, repository (JSON index), format detection, cover extraction
  ui/        Library screen
  reader/    ReaderActivity + JS bridge + asset path handler
  catalog/   OPDS parser, catalog list/browse, downloader
app/src/main/assets/reader/   index.html, reader.js, reader.css, pdf-viewer.js, text-book.js, foliate/, pdfjs/
.github/workflows/android.yml  CI: builds and uploads the APKs
```

## Licenses

OpenShelf is MIT licensed. Bundled libraries: foliate-js (MIT), pdf.js (Apache-2.0), zip.js (BSD-3), fflate (MIT).
