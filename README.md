# Lumi

Lumi means light. Lumi is your reading companion: a small round reader with a blue book and a sparkle, who sits on the empty shelf, naps under a blanket when you are away, and celebrates when you finish a book. The wordmark carries a blue page behind the L and a sparkle on the i.

A cosy e-book reader with a built-in dictionary. Fold the corner, pick up where you left off.

Runs as an Android app and as an installable web app for iPhone, iPad and desktop.

**Formats:** EPUB (2 and 3, including fixed layout), PDF, MOBI, AZW / AZW3 (KF8), FB2 / FB2.zip, CBZ comics, plain text, Markdown and HTML.

**Shelf (web app)**
- Streak card: flame, last-seven-days strip, best streak and a nudge; minutes today, this week and all time; milestone stickers; a "finished" shelf.
- Time per book: the continue card and book sheet show how long you have spent in a book and a rough time left; the finish screen shows the cover-to-cover total.
- My words: "save word" on a meaning card keeps it (with its sentence and book) in a vocabulary list with pronunciation, and a flashcard quiz to practise.
- Tags (collections), search, and a "find free books" catalog (Project Gutenberg via Gutendex, Internet Archive) that downloads straight to the shelf.
- Back up shelf / restore a backup: one zip with books, positions, highlights, stats, saved words and settings, for moving between devices (positions merge, furthest read wins).
- Android: Lumi registers as a share target once installed from Chrome. iPhone: web apps can't join the Share sheet; the in-app tips describe a Save-to-Files shortcut.

**Sources**
- Import from any file manager or cloud drive via the system file picker (multi-select).
- "Open with" / "Share to Lumi" from other apps (mail attachments, browsers, Telegram, Drive…).
- Built-in OPDS catalogs: Project Gutenberg, Standard Ebooks, Feedbooks, Unglue.it, Internet Archive — browse, search and download straight into the library.
- Add your own OPDS catalog (Calibre-Web, Kavita, Komga, Calibre content server, …).
- Download a book from a direct URL.

**Reader**
- Hold a word: meaning, translation (free MyMemory), pronunciation, and highlight colours; "whole sentence" grows the selection; "+ note" attaches a note. A "select text" mode adds a small toolbar for arbitrary passages.
- Highlights & notes are listed next to the table of contents and redraw on every open (EPUB, text and PDF).
- Lumi reads with you: a small companion in the corner of the page (its own strip below the text, switchable in Display). It greets you by time of day, hops at chapter ends, reacts to highlights and saved words, listens along when you use Listen, suggests a stretch after 45 minutes, naps under a blanket after a few idle minutes, and late at night hints that it might be time to sleep. Tap it for a word.
- Talk to Lumi: tap Lumi (or the sparkle in the top bar) to ask about the book and discuss it: what just happened, who's who, explain this part, quiz me on this chapter, or "ask lumi" about a highlighted passage. Lumi is powered by a Claude or an OpenAI model with your own API key, switchable at any time: the key stays on your device and is sent straight to that provider (you pay for what you use; pick Opus, Sonnet or Haiku, or GPT-6 Astra, Sol or Luna). The conversation is shared across providers. Only the text up to where you are is sent, and Lumi is told never to reveal what comes next. Conversations are kept per book on the device.
- Listen: read-aloud with the device voices, sentence highlighted as it goes, speed control, continues across chapters. A voice picker lists the installed voices for the book's language (Enhanced/Premium on iPhone, downloadable Google voices on Android) with a preview and a fine speed slider; footnote markers and similar noise are not read aloud.
- Presets: cosy, focus, night owl.
- Reading sessions are recorded automatically; finishing a book brings confetti.
- Long-press (or double-tap) any word to see its meaning, pronunciation and examples without leaving the page. Looked-up words are cached, so they work offline afterwards. Works in EPUBs, PDFs and text files.
- Pagination or continuous scroll, swipe or tap zones (left = back, right = forward, centre = menu).
- Themes (light, sepia, dusk, dark), text size, line spacing, margins, font family, justification.
- Table of contents, in-book search, progress slider, chapter/page indicator.
- PDF: continuous scroll, pinch and double-tap zoom, outline, text search, night mode filter.
- Reading position, covers and metadata are saved per book.
- Also runs as an installable web app for iPhone/iPad/desktop (see below).

## iPhone, iPad and desktop: the web app

The same reader ships as an installable web app (`web/`). It keeps your books in the browser's
private storage, works offline, and opens full screen from the home screen.

**Install on iPhone:** open the hosted URL in Safari, tap **Share → Add to Home Screen**. Then open
Lumi from the home screen, tap **+** and pick books from Files, iCloud Drive or Downloads.

Limits compared with the Android app: no "Open with" from other apps (use **+** or the Share sheet's
"Save to Files" first), and catalog downloads only work from sites that allow cross-origin requests.

Build it yourself: `node web/build.mjs dist` produces a static folder you can host anywhere
(GitHub Pages, Netlify, Vercel, any web server). The `Build web app` workflow does this on every push and
publishes to GitHub Pages when Pages is enabled for the repository.

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

Lumi is MIT licensed. Bundled: foliate-js (MIT), pdf.js (Apache-2.0), zip.js (BSD-3), fflate (MIT), Fraunces typeface (SIL OFL). Definitions come from the free Dictionary API and Wiktionary.
