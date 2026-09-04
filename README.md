# Tab Thumbnails Switcher

A Chrome extension that switches tabs using **most recently used (MRU)** order, with **thumbnail** previews in an overlay when you use the long-press gesture or the toolbar button.

## Screenshots

![Tab switcher overlay: MRU-ordered tabs with thumbnails, a tab-count pill, and Sort and settings buttons](images/menu_preview.png)

*Figure 1 — Tab switcher overlay. The tab-count pill and version sit beside the title, Sort and settings top right. Each row carries a favicon, title, domain and last-visit stamp, and a thumbnail; the current tab is tagged and the selection is outlined. Keyboard hints run along the bottom.*

![Options page: debug toggle, overlay key bindings, tab count and sort notes, and the advanced Ctrl+Tab snippet](images/options_preview.png)

*Figure 2 — Options page. Left: debug logging toggle, the four rebindable overlay keys, and what the tab count and Sort button do. Right: the advanced Ctrl+Tab console snippet with your extension id filled in.*

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
- **Quick switch: Ctrl+Tab (advanced)** — step-by-step instructions and a console snippet with your **extension id** already filled in (same idea as in [Binding Tab shortcuts](#binding-tab-shortcuts)).

## Keyboard shortcuts (`chrome://extensions/shortcuts`)

1. Open `chrome://extensions/shortcuts` and find **Tab Thumbnails Switcher**.
2. Suggested defaults (remap with the pencil if you like):
   - **Quick switch: previous tab (MRU) — no menu** — default **Ctrl+Shift+E**
   - **Open tab switcher (thumbnail menu)** — default **Ctrl+Shift+Q** (same chord as the in-page long-press; see `key-gesture.js`)
3. The manifest defines these in [`manifest.json`](manifest.json) under `commands`.

**Ctrl+Tab:** The normal shortcuts UI usually will not assign **Ctrl+Tab** to an extension (Chrome reserves it). See [Binding Tab shortcuts](#binding-tab-shortcuts) below for the console workaround, or use **OS-level remapping** to send your chosen shortcut.

### When the overlay is open

| Key | Action |
|-----|--------|
| **Gear** (header, top right) | Opens the extension **options** page in a new tab. |
| **Tab count** (header, next to the title) | How many tabs are open — see [Tab count](#tab-count). |
| **Sort** (header, left of the gear) | Reorders the list **and the real Chrome tab strip** — see [Sorting](#sorting). |
| S | Same as the Sort button |
| Tab / Arrow Down | Move selection down |
| Shift+Tab / Arrow Up | Move selection up |
| Enter | Switch to selected tab |
| Escape | Close the switcher |
| Click a row | Switch to that tab |

If a configured navigation key is rebound to **S**, that binding wins and the sort shortcut is skipped.

### Switch on modifier release (Alt+Tab style)

Off by default; turn it on in **Options → Overlay**. With it on, the switcher works like the Windows Alt+Tab dialog: **keep holding** the shortcut that opened it, cycle, then **let go of Ctrl to switch**. Enter and Escape keep working.

To cycle while holding, either **tap the open shortcut again** — with `Ctrl+Shift+Q`, keep Ctrl+Shift down and tap <kbd>Q</kbd> — or press <kbd>&darr;</kbd> / <kbd>&uarr;</kbd>. For the real thing, with <kbd>Tab</kbd> as the cycle key, see [Binding Tab shortcuts](#binding-tab-shortcuts).

**<kbd>Tab</kbd> pressed as a plain keystroke cannot cycle, and cannot be made to.** Chrome reserves `Ctrl+Tab` and `Ctrl+Shift+Tab` for its own tab switching and [never dispatches them to a page](https://lists.w3.org/Archives/Public/public-webapps-github/2016Jan/0255.html) — deliberately, so that a page cannot trap a keyboard-only user by swallowing every key. Firefox delivers them and ignores `preventDefault`; Chrome, Safari and Edge deliver nothing. The way around it is to bind `Ctrl+Shift+Tab` as a *command*, which arrives through the extension API rather than the page.

**What triggers the commit.** Any of Ctrl, Alt or Meta going up, once the switcher has been opened from the keyboard. The extension also tries to work out the exact chord — it asks Chrome what the shortcut is bound to (`chrome.commands.getAll`) and watches observed key state — but that is a refinement, not a requirement. It cannot be a requirement: Chrome consumes the keydown of its own command chords, so with `Ctrl+Shift+Q` as the cycle key the page never sees one keydown with Ctrl held, and if it also missed the bare Ctrl keydown — focus in the omnibox, say — it has no idea anything is held. Gating the commit on identifying the chord meant that whenever identification failed, releasing did nothing at all.

Opening the switcher by **clicking the toolbar icon** does not arm anything, so a stray Ctrl press cannot switch tabs behind your back.

The rest of the details:

- Cycling by re-tapping the shortcut only moves **forwards**; the chord already contains Shift, so there is no reversed variant of it. Use <kbd>&uarr;</kbd> to go back.
- **Shift is never the commit key.** It has to stay free to tell "previous" from "next", so `Ctrl+Shift+Q` arms on Ctrl alone and releasing Shift does nothing. For the same reason the arrows accept Shift while armed: the chord holds it down anyway, and up/down need no Shift to tell them apart.
- The held modifier is masked out when matching bindings, so a binding of plain <kbd>J</kbd> still fires while you hold Ctrl.
- The overlay takes DOM focus when it opens, so the keyup that commits lands on the document rather than in an input or iframe that held focus before.
- Detecting the release needs the page to receive the keyup, so it does not work on `chrome://` pages, the Web Store, or the PDF viewer, where content scripts never run — nor if the page has no keyboard focus at all. Turn on the debug console in Options and watch for `keyup` lines in the page devtools: no lines at all means the page is not receiving key events, which is the one case nothing here can fix.
- `Alt+Tab` cannot be the trigger: the `commands` API does not accept `Tab` as a shortcut key through the normal UI, and Windows and most Linux desktops grab Alt+Tab before Chrome sees it. Alt is a poor hold key on Windows anyway, where tapping it moves focus to Chrome's toolbar.

## Tab count

The **toolbar icon carries a badge** with the number of tabs open in the focused window, repainted as tabs open, close, move between windows, or when you switch windows. Past 999 it reads `999+`. The icon's tooltip spells the same number out, next to the version.

The switcher header shows it too: a **`12 tabs`** pill next to the title, taken from the list on screen so the two can never disagree. When more than one window is open, a muted line under it adds the cross-window total — `30 tabs in 3 windows`. Hover the pill for both numbers at once.

Only normal browser windows are counted; popups, app windows and devtools carry tabs of their own that nobody thinks of as open tabs.

## Sorting

The **Sort** button in the switcher header (or **S** while it is open) applies one combined order:

**The 10 most recently visited tabs lead**, newest first — the window's global top 10, so what you were just working on stays within reach.

**Everything after them** is sorted by:

1. **Domain** (A→Z) — tabs of the same site end up next to each other.
2. **Tab title** (A→Z) — within one site.
3. **Newest visit first** — only as a tie-break on identical titles.

This is not just a view: the **real Chrome tab strip is reordered** to match, via `chrome.tabs.move`, and the switcher then shows the new strip order.

Tabs never leave the run they belong to, so nothing gets scrambled:

- **Pinned tabs** are sorted among themselves and stay in front. They are excluded from the recent-10 head, since they already sit at the front permanently and would otherwise starve the rest of the strip of head slots.
- **Tab groups** stay intact and in place — sorting happens inside each group.
- Each stretch of **ungrouped** tabs is sorted within itself. With no tab groups (the common case) that is the whole strip, so the sort is global.

The recent head is picked once per window, then each run leads with whichever of those tabs it happens to contain — so you get one top 10 overall, not a top 10 per group. Tabs never activated in this session have no visit time, are not eligible for the head, and land at the end of their site block.

## Binding Tab shortcuts

Chrome's shortcut editor will not assign anything containing <kbd>Tab</kbd> to an extension: the `commands` API does not accept `Tab` as a shortcut key at all (the allowed set is A–Z, 0–9, Comma, Period, Home, End, PageUp, PageDown, Space, Insert, Delete, the arrow keys and media keys). Chrome's **internal** API will, from the shortcuts page.

The **Options** page generates these snippets with your extension id already filled in, and shows what each command is bound to right now. To run one by hand:

1. Open `chrome://extensions/shortcuts`, with **Developer mode** on (toggle on `chrome://extensions`).
2. Open **Developer Tools** for that tab (right-click → Inspect, or **Ctrl+Shift+J**).
3. Paste into the **Console** and press Enter, replacing `YOUR_EXTENSION_ID` with the id shown under this extension on `chrome://extensions`:

```js
// Ctrl+Tab jumps straight to the previous tab.
await chrome.developerPrivate.updateExtensionCommand({
  extensionId: "YOUR_EXTENSION_ID",
  commandName: "quick-previous-mru",
  keybinding: "Ctrl+Tab"
});

// Ctrl+Shift+Tab opens the switcher, and taps of Tab then walk it.
await chrome.developerPrivate.updateExtensionCommand({
  extensionId: "YOUR_EXTENSION_ID",
  commandName: "open-tab-switcher",
  keybinding: "Ctrl+Shift+Tab"
});
```

That pair is the arrangement worth having. With [switch on modifier release](#switch-on-modifier-release-alttab-style) turned on it reproduces Alt+Tab exactly: hold <kbd>Ctrl</kbd>+<kbd>Shift</kbd>, tap <kbd>Tab</kbd> to walk the list, let <kbd>Ctrl</kbd> go to jump. Cycling with <kbd>Tab</kbd> works **only** when bound this way, for the reason above — as a plain keystroke it never reaches the extension.

The command names are `quick-previous-mru` (no menu) and `open-tab-switcher` (thumbnail menu, and the cycle key while the menu is up). Change `keybinding` to whatever you like.

This calls `chrome.developerPrivate`, which exists on that internal page when Developer mode is on. It is **not** a stable public API — Chrome may change or remove it. Only run snippets you trust. To undo, rebind to something ordinary or press **Reset** next to the shortcut on `chrome://extensions/shortcuts`.

Failing all that, **OS-level remapping** (Windows AutoHotkey and friends) can map any chord onto whatever you assigned in `chrome://extensions/shortcuts`.

## How it works

- **MRU** — The background script tracks the order you activate tabs; “previous” tab is the second entry in that list.
- **Quick switch** — The `commands` entry `quick-previous-mru` calls the same MRU “previous tab” action from the service worker (no overlay).
- **Thumbnails** — The visible tab is captured (JPEG) when it becomes active; that image is used in the switcher.
