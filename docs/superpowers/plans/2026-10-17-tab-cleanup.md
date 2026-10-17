# Tab Cleanup (Sleep, Dedupe, Tidy-up) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Sleep (with freed-memory figure), Dedupe (with Undo) and a keyboard Tidy-up mode to the existing in-page switcher overlay.

**Architecture:** Every selection rule and every piece of toast copy lives in pure functions (`tab-logic.js`, and the tidy state reducer in `tidy-mode.js`) tested with `node --test`. `background.js` loads `tab-logic.js` via `importScripts`, does the Chrome calls, and sends the overlay precomputed data (per-tab flags, `dupCount`, tidy queue, memory, a result toast). `content.js` renders it; `tidy-mode.js` owns the tidy-up card UI.

**Tech Stack:** Plain JS, Chrome Manifest V3, `chrome.tabs` / `chrome.system.memory` / `chrome.sessions`, Node ≥18 built-in test runner (`node:test`, `node:assert/strict`). No dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-10-17-tab-cleanup-design.md`

## Global Constraints

- No npm dependencies, no bundler. New shared files use the `(function (g) { ... })(typeof self !== "undefined" ? self : this)` global-attach style of `overlay-keys.js`, plus `if (typeof module !== "undefined" && module.exports) module.exports = {...}` so Node can require them.
- Existing source files have CRLF line endings in the working tree; keep them (do not rewrite whole files with LF).
- New permissions are exactly `"system.memory"` and `"sessions"`.
- Never close or discard the active tab or a pinned tab.
- Overlay shortcuts Z / D / T are bare keys (no modifiers) and are checked **after** the configured next / prev / switch / close bindings, exactly like the existing `S` sort shortcut, so a user binding wins.
- All user-facing copy is English (matches the existing UI). Exact strings:
  - sleep toast: `Put 12 tabs to sleep · freed ~1.8 GB`; without a positive delta: `Put 12 tabs to sleep`; failures append ` · 2 could not sleep`.
  - dedupe toast: `Closed 7 duplicate tabs — the newest copy stays open` + an `Undo` button, visible ~8 s.
  - memory line: `RAM: 2.9 GB free of 16 GB`.
  - tidy counter: `37 left`; tidy summary: `Closed 12 · kept 20 · slept 5`.
- Logging goes through the existing `LOG` helpers, never bare `console.log`.

## Review Focus

1. **Tabs with an empty or unparsable URL** (still loading, `about:blank`, `chrome://newtab/`): empty-URL tabs must never be grouped as duplicates of each other; unparsable URLs compare as raw strings. → tests in Task 1.
2. **Tab IDs replaced on discard** while the overlay or tidy-up is open: switching to a slept tab must still work. → `replaceTabId` test (Task 2), tidy reducer `slept` with `newId` test (Task 5).
3. **Nothing to do** (one tab, all pinned, no duplicates): Sleep disabled, Dedupe hidden, Tidy-up opens straight onto the summary instead of an empty card. → `tidyQueue` empty test (Task 1), reducer empty-queue test (Task 5).
4. **Undo after the service worker restarted** (tidy-up can last minutes; MV3 kills idle workers ~30 s): undo batches live in `chrome.storage.session`, not a variable, and two closed copies of the same URL restore two different sessions. → `matchClosedSessions` test (Task 1); manual step in Task 7.
5. **Memory API unavailable or a negative delta** (other apps allocated memory meanwhile): no GB figure, never a negative or made-up one. → `sleepToastText` tests (Task 1).

---

### Task 1: Pure selection logic and copy (`tab-logic.js`)

**Files:**
- Create: `tab-logic.js`
- Create: `test/tab-logic.test.js`
- Modify: `package.json` (add `"scripts": { "test": "node --test" }`)

**Interfaces:**
- Produces (on `globalThis` and `module.exports`):
  - `normalizeUrl(url: string): string` — drops `#fragment`; returns `""` for empty input; returns the input unchanged if `new URL()` throws.
  - `sleepCandidates(tabs: Tab[], activeTabId: number): number[]` — ids, in input order.
  - `duplicatePlan(tabs: Tab[], mruList: number[], activeTabId: number): { toClose: number[], dupCount: Object<number, number> }` — `dupCount[id]` = group size (only for groups ≥ 2).
  - `tidyQueue(tabs: Tab[], lastAccessed: Object<number, number>, activeTabId: number): number[]` — oldest first; missing stamp counts as 0; ties keep input order.
  - `formatGB(bytes: number): string` — one decimal below 10 GB, none at/above (`1.8 GB`, `16 GB`).
  - `sleepToastText({ slept: number, failed: number, freedBytes: number|null }): string`
  - `dedupeToastText(closed: number): string`
  - `memoryLineText({ available: number, capacity: number } | null): string` — `""` for null.
  - `matchClosedSessions(records: {url:string}[], recentlyClosed: chrome.sessions.Session[]): (string|null)[]` — the `tab.sessionId` for each record, each session used at most once, `null` when none left.
  - `replaceTabId(list: number[], removedId: number, addedId: number): number[]`
  - `Tab` here means the subset `{ id, url, pinned, audible, discarded, autoDiscardable }` of `chrome.tabs.Tab`.

- [ ] **Step 1: Write the failing tests** in `test/tab-logic.test.js` (`const L = require("../tab-logic.js")`), one `test()` each:
  - `normalizeUrl`: `"https://a.com/x?p=2#top"` → `"https://a.com/x?p=2"`; `"https://a.com/x?p=2"` ≠ `normalizeUrl("https://a.com/x?p=3")`; `""` → `""`; `"not a url"` → `"not a url"`.
  - `sleepCandidates`: from tabs `[active 1, pinned 2, audible 3, discarded 4, {autoDiscardable:false} 5, plain 6, plain 7]` with active 1 → `[6, 7]`.
  - `duplicatePlan` keeps active: three tabs of `https://a.com/#x`, `https://a.com/`, `https://a.com/#y`, active = the last → `toClose` is the other two; `dupCount` is 3 for all three.
  - `duplicatePlan` keeps pinned over MRU: pinned 2 and unpinned 3 same URL, mru `[3, 2]`, active 9 elsewhere → `toClose: [3]`.
  - `duplicatePlan` keeps MRU-first: 4 and 5 same URL, mru `[5, 4]` → `toClose: [4]`; a tab absent from mru loses to one present.
  - `duplicatePlan` two pinned copies: both kept, `toClose: []`.
  - `duplicatePlan` ignores empty URLs: two tabs with `url: ""` → `toClose: []`, no `dupCount` entries.
  - `tidyQueue`: tabs 1 (active), 2 (pinned), 3 (stamp 300), 4 (no stamp), 5 (stamp 100) → `[4, 5, 3]`; all-pinned-plus-active → `[]`.
  - `formatGB`: `1.8 * 2**30` → `"1.8 GB"`; `16 * 2**30` → `"16 GB"`.
  - `sleepToastText`: `{slept:12, failed:0, freedBytes:1.8*2**30}` → `"Put 12 tabs to sleep · freed ~1.8 GB"`; `freedBytes: -5` and `null` → `"Put 12 tabs to sleep"`; `{slept:1, failed:2, freedBytes:null}` → `"Put 1 tab to sleep · 2 could not sleep"`.
  - `dedupeToastText(7)` → `"Closed 7 duplicate tabs — the newest copy stays open"`; `(1)` → `"Closed 1 duplicate tab — the newest copy stays open"`.
  - `memoryLineText({available: 2.9*2**30, capacity: 16*2**30})` → `"RAM: 2.9 GB free of 16 GB"`; `null` → `""`.
  - `matchClosedSessions`: records `[{url:"u"}, {url:"u"}, {url:"v"}]`, sessions `[{tab:{url:"u",sessionId:"a"}}, {window:{...}}, {tab:{url:"u",sessionId:"b"}}]` → `["a", "b", null]`. Match on `normalizeUrl` of both sides.
  - `replaceTabId([1,2,3], 2, 9)` → `[1,9,3]`; unknown id → unchanged copy.

- [ ] **Step 2: Run** `npm test` — Expected: FAIL, `Cannot find module '../tab-logic.js'`.
- [ ] **Step 3: Implement** `tab-logic.js` with the signatures above. `duplicatePlan` ranks each group by `(id === activeTabId) desc, pinned desc, mruIndex asc (absent = Infinity)`; keep rank 0; close the rest except active/pinned. Add the `test` script to `package.json`.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `git add tab-logic.js test/tab-logic.test.js package.json && git commit -m "feat: pure tab selection rules for sleep, dedupe and tidy-up"`

---

### Task 2: Background foundation (permissions, onReplaced, richer payload)

**Files:**
- Modify: `manifest.json` (permissions)
- Modify: `background.js` (top `importScripts`; new `onReplaced` listener next to `onRemoved` ~line 214; `showSwitcher` ~line 412)

**Interfaces:**
- Consumes: `replaceTabId`, `duplicatePlan`, `tidyQueue`, `sleepCandidates` (Task 1).
- Produces:
  - `async function readMemory(): Promise<{available:number, capacity:number} | null>` — wraps `chrome.system.memory.getInfo()`, `null` on any error.
  - `showSwitcher(opts)` accepts `opts.result: { text: string, undoBatchId?: string } | undefined` and the `show-switcher` message gains: `memory`, `memoryText: string` (= `memoryLineText(memory)`, so the page never formats it), `result`, `sleepCount: number`, `dedupeCount: number`, `tidyQueue: number[]`, and per tab `discarded`, `pinned`, `audible`, `dupCount` (0 when not duplicated).

- [ ] **Step 1: Baseline** — no new unit test (`replaceTabId` is covered in Task 1). Load unpacked, open the overlay. Expected: works as before.
- [ ] **Step 2:** `importScripts("debug-helpers.js", "tab-logic.js")`; add `"system.memory"` and `"sessions"` to `permissions`.
- [ ] **Step 3:** `chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => …)` — after `await ready()`: `mruList = replaceTabId(mruList, removedTabId, addedTabId)`; move `thumbnails[removed]` and `lastAccessed[removed]` to the added id; `saveMruList()` + `persistThumbnails()`; if `overlayTabId === removedTabId` set it to `addedTabId`.
- [ ] **Step 4:** In `showSwitcher`, add the per-tab flags to `tabMap`, compute `duplicatePlan(windowTabs, mruList, activeTab.id)`, `sleepCandidates(windowTabs, activeTab.id).length`, `tidyQueue(windowTabs, Object.fromEntries(windowTabs.map(t => [t.id, lastAccessedOf(t)])), activeTab.id)`, `await readMemory()` and its `memoryLineText`, and send them with `opts.result`. Also add a `refresh-switcher` message that calls `showSwitcher()` with no `armMods`/`openedByKey` (used by Task 6 to redraw without re-arming switch-on-release).
- [ ] **Step 5: Verify** — reload extension; open overlay; in the page devtools with debug on, the `show-switcher` log shows the new fields; `npm test` still passes; existing Sort still works.
- [ ] **Step 6: Commit** `git commit -am "feat: richer switcher payload, tab-id replacement, memory read"`

---

### Task 3: Sleep end-to-end (button, Z, 💤, memory line, toast)

**Files:**
- Modify: `background.js` (message listener ~line 579)
- Modify: `content.js` (`renderList`, `buildOverlay` header, `updateTabs`, `handleKeyDown`, `show-switcher` handler)
- Modify: `content.css`

**Interfaces:**
- Consumes: `readMemory`, payload fields (Task 2); `sleepCandidates`, `sleepToastText` (Task 1).
- Produces:
  - `async function sleepTabs(tabIds: number[]): Promise<{ slept: number, failed: number, freedBytes: number|null, replaced: Object<number, number> }>` in `background.js` — memory before, `chrome.tabs.discard` each (collect `returnedTab.id` into `replaced[old]=new` when it differs), `await new Promise(r => setTimeout(r, 1500))`, memory after; `freedBytes = after - before` or `null` if either read is null.
  - Message `sleep-tabs` (no args): sleeps `sleepCandidates` of the active window, then `showSwitcher({ result: { text: sleepToastText(r) } })`.
  - `content.js`: `function showToast(overlay, result)` — renders `result.text`, plus an `Undo` button when `result.undoBatchId` is set (button wired in Task 4); replaces any existing toast; auto-hides after 8000 ms.

- [ ] **Step 1: Implement `sleepTabs` and the `sleep-tabs` handler.**
- [ ] **Step 2: Content UI** — memory line (`.tts-header-memory`, text = `message.memoryText`, hidden when `""`); a `Sleep N` text button (`.tts-header-btn .tts-header-sleep`, `disabled` when `sleepCount === 0`) before Sort; `💤` span (`.tts-asleep`, `title="Asleep — reloads when you open it"`) in the card title when `tab.discarded`; `Z` after the `S` branch in `handleKeyDown` (skip when `sleepCount === 0`); hint bar gains `Z sleep`; `show-switcher` handler calls `showToast` when `message.result`. `updateTabs` repaints header counts too.
- [ ] **Step 3: Styles** for `.tts-header-memory`, `.tts-header-sleep[disabled]`, `.tts-asleep`, `.tts-toast` (bottom-centered inside `.tts-container`, matching existing dark/light media blocks at ~line 341).
- [ ] **Step 4: Verify** (Load unpacked, 15+ tabs): memory line shows; `Sleep N` count equals non-active, non-pinned, non-audible tabs; Z and click both sleep; cards show 💤; toast shows a GB figure or plain count; afterwards MRU order (quick-switch Ctrl+Shift+E) and thumbnails are intact. Rebind "next" to `z` in Options → Z navigates, does not sleep. `npm test` passes.
- [ ] **Step 5: Commit** `git commit -am "feat: put background tabs to sleep from the switcher"`

---

### Task 4: Dedupe with Undo

**Files:**
- Modify: `background.js`, `content.js`, `content.css`

**Interfaces:**
- Consumes: `duplicatePlan`, `dedupeToastText`, `matchClosedSessions` (Task 1); `showToast` (Task 3).
- Produces:
  - `async function closeTabsRecorded(tabIds: number[]): Promise<string|null>` — snapshot `{ url, index, windowId, pinned }` of each tab, `chrome.tabs.remove(tabIds)`, store `{ id, records }` under `chrome.storage.session` key `ttsUndoBatches` (array, newest last, capped at 20); returns the batch id (`Date.now().toString(36)` + random suffix) or `null` if nothing closed.
  - `async function undoClose(batchId: string): Promise<number>` — loads and **removes** the batch (second undo is a no-op returning 0); `matchClosedSessions(records, await chrome.sessions.getRecentlyClosed())`; `chrome.sessions.restore(sessionId)` where matched, else `chrome.tabs.create({ url, index, windowId, active: false })`; returns how many came back.
  - Messages: `dedupe-tabs` → recompute plan from live tabs, `closeTabsRecorded(plan.toClose)`, `showSwitcher({ result: { text: dedupeToastText(n), undoBatchId } })`; `undo-close { batchId }` → `undoClose`, then `sendResponse({ restored })` (return `true` from the listener) and, when `message.refresh`, `showSwitcher()`.

- [ ] **Step 1: Implement** `closeTabsRecorded`, `undoClose`, both handlers.
- [ ] **Step 2: Content UI** — `×N` badge (`.tts-dup`) after the title when `tab.dupCount > 1`; `Dedupe N` button (`.tts-header-dedupe`) shown only when `dedupeCount > 0`; `D` key after `Z`; hint `D dedupe` only when `dedupeCount > 0`; toast `Undo` sends `{ action: "undo-close", batchId, refresh: true }` and hides the toast.
- [ ] **Step 3: Styles** for `.tts-dup`, `.tts-header-dedupe`, `.tts-toast button`.
- [ ] **Step 4: Verify**: open `https://example.com/` 3× plus `https://example.com/#a` → each card `×4`, `Dedupe 3`; press D → 3 closed, the most recently visited kept, toast shows; Undo → 3 tabs back with their back-history; Undo button pressed twice does nothing the second time. `npm test` passes.
- [ ] **Step 5: Commit** `git commit -am "feat: close duplicate tabs with undo"`

---

### Task 5: Tidy-up state machine (pure)

**Files:**
- Create: `tidy-mode.js` (state part only in this task)
- Create: `test/tidy-state.test.js`

**Interfaces:**
- Produces (`globalThis.TTS_tidy` and `module.exports`):
  - `tidyInit(queue: number[]): TidyState` — `{ queue, pos: 0, history: [], stats: { closed: 0, kept: 0, slept: 0 } }`.
  - `tidyCurrent(s): number | null` — id at `pos`, `null` when done.
  - `tidyApply(s, action): TidyState` — returns a new state; `action` is one of `{type:"keep"}`, `{type:"closed", batchId}`, `{type:"slept", newId?}`, `{type:"skip"}` (tab vanished: advance, no stat), `{type:"undo"}`. History entries `{ type, pos, batchId? }`. `slept` with `newId` rewrites `queue[pos]` before advancing. `undo` pops history, restores `pos` and decrements the matching stat; on empty history it returns `s` unchanged.
  - `tidyLastUndoBatch(s): string | null` — `batchId` of the top history entry if it is `closed`, so the UI knows to send `undo-close`.

- [ ] **Step 1: Write failing tests** in `test/tidy-state.test.js`:
  - `tidyInit([])` → `tidyCurrent` is `null` (opens straight onto the summary).
  - keep, closed(`"b1"`), slept → `pos 3`, stats `{closed:1, kept:1, slept:1}`.
  - `slept` with `newId: 99` on queue `[5, 6]` → `queue[0] === 99`, current `6`.
  - closed(`"b1"`) then `tidyLastUndoBatch` → `"b1"`; then undo → `pos 0`, `closed 0`, current is the original id.
  - undo on fresh state → same object values.
  - `skip` advances without touching stats.
- [ ] **Step 2: Run** `npm test` — Expected: FAIL (`Cannot find module '../tidy-mode.js'`).
- [ ] **Step 3: Implement** the five functions in `tidy-mode.js`, guarded so the file can later also hold DOM code that only runs when called.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `git add tidy-mode.js test/tidy-state.test.js && git commit -m "feat: tidy-up state machine"`

---

### Task 6: Tidy-up UI and wiring

**Files:**
- Modify: `tidy-mode.js` (add UI), `content.js`, `content.css`, `background.js`, `manifest.json`

**Interfaces:**
- Consumes: Task 5 state functions; `closeTabsRecorded`, `undoClose` (Task 4); `sleepTabs` (Task 3); payload `tidyQueue` (Task 2).
- Produces:
  - `TTS_tidy.mount({ container: HTMLElement, tabs: Tab[], queue: number[], send: (msg) => Promise<any>, onExit: () => void, onSwitch: (tabId) => void }): { handleKey(e: KeyboardEvent): boolean, destroy(): void }` — `tabs` is the overlay's tab objects, looked up by id for the card (thumbnail, title, domain, visited, 💤, ×N). Renders `N left` and either the card or the summary (`Closed 12 · kept 20 · slept 5` + a `Back to list` button).
  - Background messages answered via `sendResponse` (listener returns `true`), never re-sending `show-switcher`: `tidy-close { tabId }` → `{ ok, batchId }` (`ok:false` if the tab is gone); `tidy-sleep { tabId }` → `{ ok, newId }` via `sleepTabs([tabId])`.

- [ ] **Step 1: Background handlers** `tidy-close`, `tidy-sleep`.
- [ ] **Step 2: `TTS_tidy.mount`** — keys (bare only, via the same no-modifier rule as `isBareKey`): `x` → `tidy-close`, `k` → keep, `z` → `tidy-sleep`, `u` → if `tidyLastUndoBatch` send `undo-close` (no `refresh`) then `undo`, else `undo`; `Enter` → `onSwitch(current)`; `Escape` → `onExit()`. A response with `ok:false` because the tab is gone → `skip`; a thrown/rejected send → error toast text `Couldn't do that — try again or press K to skip`, state unchanged. `handleKey` returns `true` when it consumed the event.
- [ ] **Step 3: `content.js` wiring** — `Tidy up` button (`.tts-header-tidy`) and `T` key after `D`; entering sets `armedMods = null; openedByKey = false`, hides `.tts-list` and the hint, and mounts into a new `.tts-tidy` element; `handleKeyDown` first delegates to the mounted tidy (`if (tidy && tidy.handleKey(e)) { e.preventDefault(); e.stopPropagation(); return; }`, and while tidy is mounted no other overlay binding runs except the configured `close` key, which exits tidy rather than the overlay); `handleKeyUp` returns early while tidy is mounted; `onExit` destroys the tidy view and sends `refresh-switcher` so the list redraws in place (not `gesture-open-switcher`, which would re-arm switch-on-release); `removeOverlay` destroys it too.
- [ ] **Step 4: Manifest/injection** — add `tidy-mode.js` before `content.js` in the second `content_scripts` group and in both `executeScript` file lists in `ensureContentScript`.
- [ ] **Step 5: Styles** for `.tts-tidy`, the big card, counter, summary, key legend (`X close · K keep · Z sleep · U undo · Enter open · Esc back`).
- [ ] **Step 6: Verify** (Load unpacked): T opens tidy on the least recently visited tab; X / K / Z / U / Enter / Esc behave per the spec table; U after X brings the tab back; the counter falls; summary at the end; closing a tab from the strip during tidy → it is skipped; with switch-on-release on, open with Ctrl+Shift+Q, press T, release Ctrl → nothing switches; a window with only the active tab → T shows the summary immediately. `npm test` passes.
- [ ] **Step 7: Commit** `git commit -am "feat: keyboard tidy-up mode in the switcher"`

---

### Task 7: Documentation and full manual pass

**Files:**
- Modify: `README.md` (new sections after `## Sorting`: `## Sleep`, `## Duplicate tabs`, `## Tidy-up`; key table under "When the overlay is open" gains Z, D, T; a line in Installation noting the two new permissions)

- [ ] **Step 1:** Write the three sections in the README's existing voice: what it does, which tabs are excluded and why, the honest memory caveat (machine-wide free memory before vs after, so other apps move it), Undo and its 25-entry `chrome.sessions` limit with the `tabs.create` fallback.
- [ ] **Step 2:** Run the spec's 7-step manual checklist end-to-end plus: Dedupe, wait 60 s (worker idles out; confirm in `chrome://serviceworker-internals` or the extension's worker status), press Undo → tabs still come back.
- [ ] **Step 3:** `npm test` — Expected: all pass.
- [ ] **Step 4: Commit** `git commit -am "docs: sleep, duplicate tabs and tidy-up"`
