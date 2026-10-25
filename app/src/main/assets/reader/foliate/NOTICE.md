# foliate-js (vendored)

Source: https://github.com/johnfactotum/foliate-js — npm `foliate-js@1.0.1`, MIT License (see LICENSE).

Local modifications:
- `fixed-layout.js`: removed the bare `construct-style-sheets-polyfill` import (not needed in Android WebView, and bare specifiers cannot be resolved without a bundler).
- `paginator.js`: `render()` skips a section document whose body has not loaded yet, `getVisibleRange()`/`#afterScroll()` skip relocation for such a document, and `setStylesImportant` ignores a null element (avoids a console error while a section document is still loading in scrolled mode).
