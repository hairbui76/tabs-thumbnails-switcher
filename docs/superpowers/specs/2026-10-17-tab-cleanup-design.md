# Tab cleanup: Sleep, Dedupe, Tidy-up — design

Date: 2026-10-17 · Status: approved in conversation, pending spec review

## Goal

Add three tab-cleanup features to the existing switcher overlay, so a crowded
window can be slimmed down without leaving the overlay:

1. **Sleep** background tabs to free memory, and show how much was freed.
2. **Dedupe** tabs that point at the same page.
3. **Tidy-up**, a keyboard triage mode that walks through tabs one at a time.

This is phase 1 of a larger effort. Out of scope here, planned for later phases:
a "Later" saved-links list, ⌘K search over saved and closed tabs, window/session
restore after a crash, and themes. Tidy-up reserves the `S` key for "save to
Later" in phase 2.

The features are re-implemented from scratch for this extension; no code, names
or assets are taken from other products.

## Constraints

- Plain JavaScript, Manifest V3, no build step — same as today.
- Everything lives inside the existing in-page overlay. Like the overlay today,
  it does not run on `chrome://` pages, the Web Store or the PDF viewer.
- The overlay already owns `S` (sort), the configurable next / prev / switch /
  close keys, and the optional switch-on-modifier-release mode. New keys must
  coexist with all of these.

## Feature 1 — Sleep

### What counts as a candidate

Every tab in the current window **except**:

- the active tab,
- tabs already discarded (`tab.discarded`),
- audible tabs (`tab.audible`),
- tabs with `autoDiscardable === false`,
- pinned tabs (usually mail or chat that should stay live).

### Memory figure

Chrome gives extensions no per-tab memory figure on the stable channel, so the
number shown is the change in the machine's free memory, read through
`chrome.system.memory.getInfo()` (`availableCapacity`, `capacity`):

1. Read `availableCapacity`.
2. `chrome.tabs.discard()` each candidate.
3. Wait ~1500 ms (Chrome releases renderer memory with a short delay).
4. Read `availableCapacity` again; `freed = after - before`.

The figure is real but noisy (other applications allocate and free memory too).
When `freed <= 0` the result says only how many tabs were put to sleep — never a
made-up number, never an estimate per tab.

### UI

- Header gains a memory line: `RAM: 2.9 GB free of 16 GB`. If `system.memory`
  fails, the line is hidden.
- Header gains a **Sleep N** button (N = candidate count), disabled at N = 0.
- Shortcut **Z**, skipped when a configured navigation key is bound to Z (same
  rule the `S` sort shortcut follows today).
- After a sleep the overlay re-renders and shows a toast:
  `Put 12 tabs to sleep · freed ~1.8 GB` (or without the GB part, see above).
- Sleeping tabs carry a small 💤 marker on their card and keep their cached
  thumbnail. Clicking one switches to it; Chrome reloads it.

### Tab ID changes

Some Chrome versions give a tab a new ID when it is discarded, announced through
`chrome.tabs.onReplaced(addedTabId, removedTabId)`. `background.js` does not
listen to it today. A new handler rewrites the old ID to the new one in
`mruList`, `thumbnails` and `lastAccessed`, and persists them, so MRU order and
thumbnails survive a sleep.

### Errors

A tab whose `discard` call rejects is skipped and counted separately; the toast
mentions it (`… · 2 could not sleep`).

## Feature 2 — Dedupe

### Duplicate rule

Two tabs are duplicates when their URLs are equal after dropping the `#fragment`.
The query string is kept (`?page=2` and `?page=3` are different pages). Only the
current window is considered, matching what the overlay shows.

### Which copy stays

Within each duplicate group exactly one tab is kept, chosen by:

1. the active tab, else
2. a pinned tab, else
3. the most recently used one (earliest position in `mruList`; tabs absent from
   `mruList` rank last).

The others are closed, with two exceptions: the active tab and pinned tabs are
never closed. A group holding two pinned copies keeps both.

### UI

- Cards with copies show a **×N** badge next to the title (N = size of the group).
- Header gains a **Dedupe N** button (N = tabs that would close), hidden at N = 0.
- Shortcut **D**, with the same conflict rule as Z and S.
- After deduping the overlay re-renders and shows a toast for ~8 s:
  `Closed 7 duplicate tabs — the newest copy stays open · [Undo]`.

### Undo

Background remembers the closed tabs (URL, index, window, pinned, group id).
`Undo` reopens them with `chrome.sessions.restore(sessionId)`, matching each
entry from `chrome.sessions.getRecentlyClosed()` by URL, which preserves the
back/forward history. If no matching session entry exists (Chrome keeps at most
25) or restore fails, fall back to `chrome.tabs.create({ url, index, windowId })`.

### Flow

Overlay sends `dedupe-tabs`. Background recomputes the plan from live tabs (never
trusts the list the overlay rendered, which may be stale), closes, stores the
undo record, then sends `show-switcher` with the result. `Undo` sends
`undo-close` with the batch id.

## Feature 3 — Tidy-up

### Entering

Header button **Tidy up**, or key **T**. The list is replaced by a single large
card for the tab under review: big thumbnail, title, domain, last visit, and the
💤 / ×N markers. A counter above it reads `37 left`.

### Queue

Tabs of the current window, least recently visited first (ascending
`lastAccessed`; tabs with no stamp first). The active tab and pinned tabs are
excluded.

### Keys (fixed in phase 1, not configurable)

| Key | Action |
|-----|--------|
| X | Close the tab, go to next |
| K | Keep, go to next |
| Z | Sleep the tab, go to next |
| U | Undo the last step (reopen a closed tab, or step back a card) |
| Enter | Switch to that tab and close the overlay |
| Escape | Leave tidy-up, back to the list |

While tidy-up is active, the regular overlay bindings (next / prev / switch /
sort) are not handled, except Escape.

### End

When the queue is empty, a summary replaces the card:
`Closed 12 · kept 20 · slept 5`, with a button back to the list.

### Flow and state

Each key acts immediately through a message (`tidy-close`, `tidy-sleep` with
`tabId`); leaving halfway keeps whatever was done. The queue and the undo stack
live in the overlay only and are lost when the overlay closes. Undoing a close
reuses the `undo-close` path from Dedupe.

### Interaction with switch-on-release

Entering tidy-up disarms commit-on-release, so letting go of Ctrl cannot switch
tabs mid-triage.

### Errors

A tab that was closed elsewhere during triage is skipped silently. An action that
fails shows an error toast and leaves the card in place.

## Code layout

### New files

- `tab-logic.js` — pure functions, no `chrome.*` calls, loaded by the service
  worker through `importScripts` and by Node tests through `module.exports`
  (same global-attach style as `overlay-keys.js`):
  - `normalizeUrl(url)`
  - `sleepCandidates(tabs, activeTabId)`
  - `duplicatePlan(tabs, mruList, activeTabId)` → `{ toClose: [ids], dupCount: {id: n} }`
  - `tidyQueue(tabs, lastAccessedOf, activeTabId)` → ordered ids
- `tidy-mode.js` — tidy-up UI, a content script loaded before `content.js`.
  Kept out of `content.js`, which is already 631 lines.
- `test/tab-logic.test.js` — `node --test`, no dependencies.

### Changed files

- `background.js` — `importScripts("tab-logic.js")`; handlers for `sleep-tabs`,
  `dedupe-tabs`, `undo-close`, `tidy-close`, `tidy-sleep`; `tabs.onReplaced`;
  `show-switcher` payload gains `memory: { available, capacity } | null`,
  `result` (for the toast), and per-tab `discarded`, `pinned`, `audible`,
  `dupCount`.
- `content.js` — memory line, Sleep / Dedupe / Tidy up buttons, 💤 and ×N
  badges, toast, Z / D / T keys, hint bar text.
- `content.css` — styles for the above.
- `manifest.json` — permissions `system.memory` and `sessions`; `tidy-mode.js`
  in the second content-script group.
- `background.js` `ensureContentScript` — inject `tidy-mode.js` too.
- `package.json` — `"scripts": { "test": "node --test" }`.
- `README.md` — sections for Sleep, Dedupe and Tidy-up in the existing style;
  key table updated.

## Testing

Automated (`npm test`): the selection rules in `tab-logic.js`.

- `sleepCandidates` excludes active, discarded, audible, non-auto-discardable
  and pinned tabs.
- `normalizeUrl` drops the fragment, keeps the query, tolerates unparsable URLs.
- `duplicatePlan` keeps active > pinned > MRU, never closes active or pinned,
  keeps two pinned copies, reports `dupCount`.
- `tidyQueue` orders oldest first, excludes active and pinned.

Manual checklist (Load unpacked, then):

1. Open 15+ tabs, open the overlay: memory line and Sleep N appear.
2. Sleep: cards show 💤, toast shows a GB figure or a plain count; MRU order and
   thumbnails are intact afterwards (onReplaced).
3. Open the same URL 3× plus once with a different `#hash`: ×4 badges, Dedupe 3.
4. Dedupe, then Undo: tabs return with back-history.
5. Tidy-up with X / K / Z / U / Enter / Escape; summary at the end.
6. With switch-on-release on: enter tidy-up, release Ctrl — nothing switches.
7. Rebind "next" to Z in Options: Z no longer triggers Sleep.
