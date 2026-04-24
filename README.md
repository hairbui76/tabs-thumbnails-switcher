# Tab Thumbnails Switcher

A Chrome extension that switches tabs using **most recently used (MRU)** order, with **thumbnail** previews in an overlay when you use the long-press gesture or the toolbar button.

## Screenshots

![Tab switcher overlay with thumbnails and shortcuts](images/menu_preview.png)

*Figure 1 — Tab switcher overlay: MRU-ordered tabs with thumbnails, version under the title, settings gear, and keyboard hints.*

![Extension options: overlay keys, Ctrl+Tab note, about](images/options_preview.png)

*Figure 2 — Options page: debug logging toggle, overlay navigation keys, Ctrl+Tab advanced console snippet, and about metadata.*

## Installation

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select this folder
5. The extension is now active

## Options (debug console)

- Right-click the extension icon → **Options**, or from `chrome://extensions` open **Extension options** for this extension.
- **Enable debug console (verbose logs)** — when off, `[TTS …]` logs are suppressed in the service worker and in page devtools. Default is off.
- **Overlay (when the tab switcher is open)** — set **Next / Previous / Switch to selected / Close** by clicking **Change…** and pressing a key (modifiers like Shift / Ctrl are captured). **Escape** cancels capture. The hint bar in the switcher uses these labels. You can also enable **Arrow Up / Arrow Down** for navigation in addition to your custom keys (default: on, same as the old behavior).
- **Quick switch: Ctrl+Tab (advanced)** — step-by-step instructions and a console snippet with your **extension id** already filled in (same idea as in [Can I use Ctrl+Tab for quick switch?](#can-i-use-ctrltab-for-quick-switch)).

## Keyboard shortcuts (`chrome://extensions/shortcuts`)

1. Open `chrome://extensions/shortcuts` and find **Tab Thumbnails Switcher**.
2. Suggested defaults (remap with the pencil if you like):
   - **Quick switch: previous tab (MRU) — no menu** — default **Ctrl+Shift+E**
   - **Open tab switcher (thumbnail menu)** — default **Ctrl+Shift+Q** (same chord as the in-page long-press; see `key-gesture.js`)
3. The manifest defines these in [`manifest.json`](manifest.json) under `commands`.

**Why not plain Ctrl+E for quick switch?** `suggested_key` in the manifest is only a *hint* Chrome may apply on first install. It skips combinations that are **built-in browser shortcuts** (e.g. **Ctrl+E** on Windows) so that row can look like **Chưa đặt** / *Not set* if we put **Ctrl+E** in the manifest. The default is **Ctrl+Shift+E** so it can bind on a fresh install. You can still try other keys in `chrome://extensions/shortcuts`; for **plain Ctrl+E**, use an **OS-level remap** (e.g. **AutoHotkey**) to send **Ctrl+Shift+E** (or whatever you assigned for quick switch).

This runs in the **service worker** and works in Chrome **even on pages** where a content script cannot (e.g. you can rebind in Shortcuts; it is not limited to normal web pages the way a page-injected key handler is).

**Ctrl+Tab:** The normal shortcuts UI usually will not assign **Ctrl+Tab** to an extension (Chrome reserves it). See [Can I use Ctrl+Tab for quick switch?](#can-i-use-ctrltab-for-quick-switch) below for an **advanced** console workaround on `chrome://extensions/shortcuts`, or use **OS-level remapping** to send your chosen shortcut.

## In-page: long-press to open the menu (default: Ctrl+Shift+Q)

Long-press is implemented in the page by [`key-gesture.js`](key-gesture.js) (hold duration is not available to `chrome.commands`). The default chord matches the **Open tab switcher** command so behavior is consistent.

| What you do | What happens |
|-------------|----------------|
| **Command: Open tab switcher (thumbnail menu)** (default **Ctrl+Shift+Q** in the manifest) | Opens the full switcher; works from the service worker, including on many `chrome://` / restricted pages where a content script may not. |
| **Press and keep holding** Ctrl+Shift+Q (or your edited `G` in `key-gesture.js`) for the hold time | Same menu from the in-page long-press where the script runs. **A short** press + release (before the hold time) does **not** open the menu by itself—use the **open-tab-switcher** command or a longer hold. |
| **Quick switch to previous tab** (default **Ctrl+Shift+E**) | Jumps to the previous MRU tab with **no** overlay. |
| **Click the extension icon** | Always opens the **full** thumbnail switcher. |

- **Hold time** and in-page **chord**: `HOLD_MS` and `G` in [`key-gesture.js`](key-gesture.js), then reload the extension.
- If a shortcut conflicts with Chrome or the OS, change it in `chrome://extensions/shortcuts` or in `G`.

### When the overlay is open

| Key | Action |
|-----|--------|
| **Gear** (header, top right) | Opens the extension **options** page in a new tab. |
| Tab / Arrow Down | Move selection down |
| Shift+Tab / Arrow Up | Move selection up |
| Enter | Switch to selected tab |
| Escape | Close the switcher |
| Click a row | Switch to that tab |

## Can I use Ctrl+Tab for quick switch?

**Usually not through the pencil UI** — Chrome reserves **Ctrl+Tab** for built‑in tab switching, so the shortcuts page often will not let you pick it for **Quick switch: previous tab (MRU)**.

- **Default:** set **Quick switch** to any free combination in `chrome://extensions/shortcuts` (e.g. **Ctrl+Shift+E**).

If you specifically want **Ctrl+Tab**:

1. **Advanced (Chrome only, internal API)** — On `chrome://extensions/shortcuts`, with **Developer mode** enabled (toggle on `chrome://extensions`), open **Developer Tools** for that tab (e.g. right‑click → Inspect, or **Ctrl+Shift+J**). In the **Console**, paste (replace `YOUR_EXTENSION_ID` with the id shown under this extension on `chrome://extensions`; the **Options** page of this extension can show a ready‑to‑paste snippet with your id filled in):

   ```js
   await chrome.developerPrivate.updateExtensionCommand({
     extensionId: "YOUR_EXTENSION_ID",
     commandName: "quick-previous-mru",
     keybinding: "Ctrl+Tab"
   });
   ```

   This calls `chrome.developerPrivate`, which exists on that internal page when Developer mode is on. It is **not** a stable public API—Chrome may change or remove it. Only run snippets you trust.

2. **OS remap** — Map **Ctrl+Tab** (while Chrome is focused) to whatever key you assigned for quick switch in `chrome://extensions/shortcuts` (e.g. **Ctrl+Shift+E**) using an **OS tool** (e.g. Windows **AutoHotkey**). Same idea if you want **plain Ctrl+E** for quick switch: remap at the OS to the extension’s assigned shortcut.

## How it works

- **MRU** — The background script tracks the order you activate tabs; “previous” tab is the second entry in that list.
- **Quick switch** — The `commands` entry `quick-previous-mru` calls the same MRU “previous tab” action from the service worker (no overlay).
- **Thumbnails** — The visible tab is captured (JPEG) when it becomes active; that image is used in the switcher.
- **Hold-to-open menu** — The content script uses `keydown` / `keyup` and a timer; Chrome’s `commands` cannot measure hold duration, so the menu gesture stays in the page.
- **Restricted / special pages** — The **Quick switch** shortcut still works globally in Chrome. The **in-page** hold may not run on `chrome://` etc.; use the shortcut or the toolbar to open the menu on injectable pages.

## Permissions

| Permission | Reason |
|------------|--------|
| `tabs` | Read tab info for the list and to activate tabs |
| `activeTab` | Capture the visible area for thumbnails |
| `scripting` + `<all_urls>` | Inject the gesture script, overlay, and styles |
| `storage` | Persist MRU order if the service worker is restarted |

## File structure

```
tabs-thumbnails-switcher/
  manifest.json
  background.js
  debug-helpers.js
  key-gesture.js
  overlay-keys.js
  content.js
  content.css
  options.html
  options.js
  icons/
  images/
    menu_preview.png
    options_preview.png
  README.md
```

## License

MIT
