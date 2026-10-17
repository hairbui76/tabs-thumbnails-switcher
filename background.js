importScripts("debug-helpers.js", "tab-logic.js");
const LOG = self.__ttsCreateTtsLog("background");

/** Session key for JPEG data URLs; survives MV3 service worker sleep, clears when browser closes. */
const TTS_THUMBNAILS_SESSION_KEY = "ttsTabThumbnails";
/** Session key for our own "last activated at" stamps (fallback for Chrome < 121 tab.lastAccessed). */
const TTS_LAST_ACCESSED_SESSION_KEY = "ttsLastAccessed";

let mruList = [];
let thumbnails = {};
let lastAccessed = {};
let captureTimer = null;
/**
 * Tab whose page currently has the switcher up, so a second press of the open
 * shortcut can advance the selection instead of rebuilding the overlay. The content
 * script reports both ends; a stale value self-heals on the next press.
 */
let overlayTabId = null;

/**
 * The service worker is torn down when idle, so every event handler must wait for
 * the session state to be re-read before touching mruList — otherwise the first
 * command after a wake-up sees an empty list and silently does nothing.
 */
let readyPromise = null;
function ready() {
  if (!readyPromise) readyPromise = initMruList();
  return readyPromise;
}

async function saveMruList() {
  try {
    await chrome.storage.session.set({
      mruList,
      [TTS_LAST_ACCESSED_SESSION_KEY]: lastAccessed,
    });
  } catch (e) {
    LOG("saveMruList error:", e.message);
  }
}

async function loadMruList() {
  try {
    const data = await chrome.storage.session.get([
      "mruList",
      TTS_THUMBNAILS_SESSION_KEY,
      TTS_LAST_ACCESSED_SESSION_KEY,
    ]);
    if (data.mruList) {
      mruList = data.mruList;
      LOG("loaded MRU list:", mruList);
    }
    const saved = data[TTS_THUMBNAILS_SESSION_KEY];
    if (saved && typeof saved === "object") {
      for (const [k, v] of Object.entries(saved)) {
        if (typeof v === "string" && v.startsWith("data:image")) thumbnails[k] = v;
      }
      LOG("restored tab thumbnails:", Object.keys(thumbnails).length);
    }
    const stamps = data[TTS_LAST_ACCESSED_SESSION_KEY];
    if (stamps && typeof stamps === "object") {
      for (const [k, v] of Object.entries(stamps)) {
        if (typeof v === "number") lastAccessed[k] = v;
      }
    }
  } catch (e) {
    LOG("loadMruList error:", e.message);
  }
}

function lastAccessedOf(tab) {
  return tab.lastAccessed || lastAccessed[tab.id] || 0;
}

async function persistThumbnails() {
  try {
    await chrome.storage.session.set({ [TTS_THUMBNAILS_SESSION_KEY]: thumbnails });
  } catch (e) {
    LOG("persistThumbnails error:", e.message);
  }
}

/** Badge digits Chrome can still render legibly; past this we show "999+". */
const BADGE_MAX = 999;

/**
 * Paints one window's open-tab count onto the toolbar icon, and spells it out in the
 * tooltip where there is room. Scoped to a single window because that is what the
 * switcher itself lists.
 *
 * Pass the windowId from a window event; on tab events "currentWindow" is enough and
 * is what the rest of this worker already resolves against.
 */
async function updateTabCountBadge(windowId) {
  try {
    const tabs = await chrome.tabs.query(
      windowId != null ? { windowId } : { currentWindow: true }
    );
    const count = tabs.length;
    const text = count > BADGE_MAX ? BADGE_MAX + "+" : count ? String(count) : "";
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: "#3b5bdb" });
    // Chrome 110+; without it Chrome picks a contrasting colour itself.
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: "#ffffff" });
    }

    const v = chrome.runtime.getManifest().version;
    const parts = ["Open tab switcher (thumbnail menu)"];
    parts.push(count === 1 ? "1 tab open" : count + " tabs open");
    if (v) parts.push("v" + v);
    await chrome.action.setTitle({ title: parts.join(" · ") });

    LOG("badge:", text || "(empty)", "window:", windowId != null ? windowId : "current");
  } catch (e) {
    // A window closing out from under us leaves nothing to count; the next event repaints.
    LOG("updateTabCountBadge:", e && e.message);
  }
}

async function initMruList() {
  LOG("initializing...");
  void updateTabCountBadge();
  try {
    await loadMruList();
    if (mruList.length === 0) {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const activeTab = tabs.find((t) => t.active);
      mruList = tabs
        .slice()
        .sort((a, b) => lastAccessedOf(b) - lastAccessedOf(a))
        .map((t) => t.id);
      if (activeTab) {
        mruList = [activeTab.id, ...mruList.filter((id) => id !== activeTab.id)];
      }
      await saveMruList();
      LOG("built initial MRU list:", mruList);
    }
  } catch (e) {
    // Never leave ready() permanently rejected — a degraded list still beats a dead shortcut.
    LOG("init failed:", e && e.message);
  }
  LOG("ready");
}

/**
 * Re-syncs mruList with reality: drops closed tabs and puts the tab Chrome really
 * considers active at the head. Events can be missed while the worker is asleep,
 * and a stale head makes "switch to previous" resolve to the current tab (a no-op).
 */
async function reconcileMruList() {
  const allTabs = await chrome.tabs.query({});
  const byId = new Map(allTabs.map((t) => [t.id, t]));
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let next = mruList.filter((id) => byId.has(id));
  // Tabs we never saw activated (worker was asleep, or they predate it) go after the
  // tracked ones, newest visit first — not in window/index order.
  const unknown = allTabs
    .filter((t) => !next.includes(t.id))
    .sort((a, b) => lastAccessedOf(b) - lastAccessedOf(a));
  for (const tab of unknown) next.push(tab.id);
  if (activeTab) {
    next = [activeTab.id, ...next.filter((id) => id !== activeTab.id)];
  }

  const changed = next.length !== mruList.length || next.some((id, i) => id !== mruList[i]);
  if (changed) {
    LOG("reconciled MRU list:", mruList, "->", next);
    mruList = next;
    for (const key of Object.keys(lastAccessed)) {
      if (!byId.has(Number(key))) delete lastAccessed[key];
    }
    await saveMruList();
  }
  return { allTabs, byId, activeTab };
}

function captureTab(windowId, tabId) {
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(async () => {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: "jpeg",
        quality: 50,
      });
      const [active] = await chrome.tabs.query({ active: true, windowId });
      if (!active || active.id !== tabId) {
        LOG("capture skipped: visible tab", active?.id, "!== expected", tabId);
        return;
      }
      thumbnails[tabId] = dataUrl;
      LOG("captured thumbnail for tab", tabId, `(${(dataUrl.length / 1024).toFixed(1)} KB)`);
      await persistThumbnails();
    } catch (e) {
      LOG("capture failed for tab", tabId, ":", e.message);
    }
  }, 300);
}

/**
 * Non-zero while Undo is reopening tabs and handing focus back. sessions.restore
 * activates each tab it brings back; those are not visits, so they must not reorder the
 * MRU list, stamp a visit, or capture a thumbnail (which would be the overlay itself).
 */
let quietActivations = 0;
/** Activation events can arrive after the API promise that caused them resolves. */
const QUIET_ACTIVATION_SETTLE_MS = 300;

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { tabId, windowId } = activeInfo;
  // Checked before any await, so the event is judged by when it arrived.
  if (quietActivations > 0) {
    LOG("tab activated:", tabId, "window:", windowId, "— by Undo, not tracked");
    void updateTabCountBadge(windowId);
    return;
  }
  LOG("tab activated:", tabId, "window:", windowId);

  await ready();
  mruList = [tabId, ...mruList.filter((id) => id !== tabId)];
  lastAccessed[tabId] = Date.now();
  await saveMruList();

  captureTab(windowId, tabId);
  void updateTabCountBadge(windowId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  LOG("tab removed:", tabId);
  if (overlayTabId === tabId) overlayTabId = null;
  await ready();
  mruList = mruList.filter((id) => id !== tabId);
  delete thumbnails[tabId];
  delete lastAccessed[tabId];
  await saveMruList();
  await persistThumbnails();
  void updateTabCountBadge();
});

/**
 * Some Chrome versions give a tab a new id when it is discarded (slept). Carry its
 * MRU position, thumbnail and visit stamp over to the new id so switching to a slept
 * tab, and quick-switch order, keep working.
 */
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  LOG("tab replaced:", removedTabId, "->", addedTabId);
  if (overlayTabId === removedTabId) overlayTabId = addedTabId;
  // The open overlay (and tidy-up in it) holds tab ids; tell it before they go stale.
  if (overlayTabId != null) {
    chrome.tabs
      .sendMessage(overlayTabId, { action: "tab-replaced", oldId: removedTabId, newId: addedTabId })
      .catch(() => {});
  }
  await ready();
  // Drop any entry the new id already has (onCreated may have pushed it) so it is
  // not listed twice.
  if (mruList.includes(removedTabId)) {
    mruList = replaceTabId(
      mruList.filter((id) => id !== addedTabId),
      removedTabId,
      addedTabId
    );
  }
  const thumbnailMoved = !!thumbnails[removedTabId];
  if (thumbnailMoved) {
    thumbnails[addedTabId] = thumbnails[removedTabId];
    delete thumbnails[removedTabId];
  }
  if (lastAccessed[removedTabId]) {
    lastAccessed[addedTabId] = lastAccessed[removedTabId];
    delete lastAccessed[removedTabId];
  }
  await saveMruList();
  // Sleeping N tabs can fire N replaces; each persist writes the whole map.
  if (thumbnailMoved) await persistThumbnails();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  LOG("tab created:", tab.id);
  await ready();
  if (!mruList.includes(tab.id)) {
    mruList.push(tab.id);
    await saveMruList();
  }
  void updateTabCountBadge();
});

// A tab dragged between windows changes the count of both, and the badge only ever
// shows the focused one — so repaint on either half of the move.
chrome.tabs.onAttached.addListener(() => void updateTabCountBadge());
chrome.tabs.onDetached.addListener(() => void updateTabCountBadge());

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void updateTabCountBadge(windowId);
});

chrome.windows.onRemoved.addListener(() => void updateTabCountBadge());

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) {
    LOG("tab finished loading:", tabId, tab.url);
    captureTab(tab.windowId, tabId);
  }
});

/** Most recently used tab of the active window that is not the active tab itself. */
async function findPreviousTab() {
  const { byId, activeTab } = await reconcileMruList();
  if (!activeTab) {
    LOG("quick-mru: no active tab");
    return null;
  }
  for (const id of mruList) {
    const tab = byId.get(id);
    if (tab && tab.id !== activeTab.id && tab.windowId === activeTab.windowId) return tab;
  }
  // MRU knows nothing usable (fresh worker, single-tab history) — fall back to timestamps.
  const candidates = [...byId.values()]
    .filter((t) => t.id !== activeTab.id && t.windowId === activeTab.windowId)
    .sort((a, b) => lastAccessedOf(b) - lastAccessedOf(a));
  return candidates[0] || null;
}

async function quickSwitchToPreviousMru() {
  await ready();
  const prev = await findPreviousTab();
  if (!prev) {
    LOG("quick-mru: no other tab in this window");
    return;
  }
  LOG("quick-mru: switch to", prev.id);
  try {
    await chrome.tabs.update(prev.id, { active: true });
  } catch (e) {
    LOG("quick-mru: switch failed:", e && e.message);
  }
}

/** Registrable domain-ish key used to group tabs of the same site together. */
function domainKey(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host) return host;
  } catch (e) {}
  return url || "";
}

/** How many of the most recently visited tabs are kept up front, ordered by visit time. */
const SORT_RECENT_HEAD = 10;

/** Comparator for the tail of the sort: domain → tab title → most recent visit. */
function byDomainTitleVisit(a, b) {
  const ka = domainKey(a.url);
  const kb = domainKey(b.url);
  if (ka !== kb) return ka.localeCompare(kb);
  const byTitle = (a.title || "").localeCompare(b.title || "", undefined, {
    sensitivity: "base",
  });
  if (byTitle !== 0) return byTitle;
  return lastAccessedOf(b) - lastAccessedOf(a);
}

/**
 * The SORT_RECENT_HEAD most recently visited tabs of the window, as a Set of ids.
 * Chosen once across the whole window so the head is a global top-10, not a top-10 per
 * run. Pinned tabs are excluded: they already sit at the front permanently, and letting
 * them claim head slots would starve the rest of the strip. Tabs never activated in
 * this session have no visit time and are not eligible.
 */
function recentHeadIds(windowTabs) {
  const ranked = windowTabs
    .filter((t) => !t.pinned && lastAccessedOf(t) > 0)
    .sort((a, b) => lastAccessedOf(b) - lastAccessedOf(a))
    .slice(0, SORT_RECENT_HEAD);
  return new Set(ranked.map((t) => t.id));
}

/**
 * The sort behind the toolbar's Sort button: whichever of these tabs are in the
 * window's recent head lead, newest visit first; everything after them is grouped by
 * domain, then by tab title, then by visit time.
 */
function sortForStrip(tabs, headIds) {
  const head = tabs
    .filter((t) => headIds.has(t.id))
    .sort((a, b) => lastAccessedOf(b) - lastAccessedOf(a));
  const tail = tabs.filter((t) => !headIds.has(t.id)).sort(byDomainTitleVisit);
  return head.concat(tail);
}

/**
 * Splits the strip into runs that a tab may not leave: the pinned block, each tab
 * group, and each stretch of ungrouped tabs between them. Sorting inside a run keeps
 * every tab at an index it already belongs to, so pinning and tab groups survive.
 * With no groups (the common case) the whole unpinned strip is a single run.
 */
function stripBlocks(windowTabs) {
  const ordered = windowTabs.slice().sort((a, b) => a.index - b.index);
  const blocks = [];
  let current = null;
  for (const tab of ordered) {
    const key = tab.pinned ? "pinned" : "group:" + (tab.groupId != null ? tab.groupId : -1);
    if (!current || current.key !== key) {
      current = { key, start: tab.index, tabs: [] };
      blocks.push(current);
    }
    current.tabs.push(tab);
  }
  return blocks;
}

/** Rearranges the real Chrome tab strip to match the sort. */
async function sortWindowTabs() {
  await ready();
  const { allTabs, activeTab } = await reconcileMruList();
  if (!activeTab) {
    LOG("sort: no active tab");
    return false;
  }
  const windowTabs = allTabs.filter((t) => t.windowId === activeTab.windowId);
  const headIds = recentHeadIds(windowTabs);

  try {
    for (const block of stripBlocks(windowTabs)) {
      if (block.tabs.length < 2) continue;
      const sorted = sortForStrip(block.tabs, headIds);
      if (sorted.every((tab, i) => tab.id === block.tabs[i].id)) continue;
      await chrome.tabs.move(sorted.map((t) => t.id), { index: block.start });
      LOG("sorted block", block.key, "at index", block.start, "-", sorted.length, "tabs");
    }
    return true;
  } catch (e) {
    // Chrome refuses moves while the user is dragging a tab; nothing to recover from.
    LOG("sort: move failed:", e && e.message);
    return false;
  }
}

/**
 * Tab totals for the overlay header. Only normal browser windows are counted: popups,
 * app windows and devtools carry tabs of their own that nobody thinks of as open tabs.
 * Falls back to the raw totals if the windows API is unavailable.
 */
async function tabCounts(allTabs, windowId) {
  let counted = allTabs;
  let windows = 0;
  try {
    const normal = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const ids = new Set(normal.map((w) => w.id));
    counted = allTabs.filter((t) => ids.has(t.windowId));
    windows = ids.size;
  } catch (e) {
    LOG("tabCounts: windows.getAll failed:", e && e.message);
    windows = new Set(allTabs.map((t) => t.windowId)).size;
  }
  return {
    window: counted.filter((t) => t.windowId === windowId).length,
    total: counted.length,
    windows,
  };
}

/**
 * Machine-wide memory as { available, capacity } in bytes, or null when the
 * system.memory API is missing or fails — callers then show no memory figure.
 */
async function readMemory() {
  try {
    if (!chrome.system || !chrome.system.memory) {
      LOG("readMemory: system.memory API unavailable");
      return null;
    }
    const info = await chrome.system.memory.getInfo();
    return { available: info.availableCapacity, capacity: info.capacity };
  } catch (e) {
    LOG("readMemory failed:", e && e.message);
    return null;
  }
}

/** Chrome hands renderer memory back with a short delay after a discard. */
const SLEEP_SETTLE_MS = 1500;

/**
 * Discards (puts to sleep) each tab and measures how much machine-wide free memory
 * that released. No filtering here: callers pass exactly the tabs to sleep.
 *
 * A discard that rejects, or resolves without a tab, counts as failed. Chrome may
 * give a discarded tab a new id; `replaced` maps old id -> new id for those.
 * `freedBytes` is the change in free memory, or null when either reading failed or
 * nothing slept (a figure then would be pure noise from other apps).
 *
 * `opts.measure === false` skips the memory readings and the settle wait (freedBytes is
 * then null): tidy-up sleeps one tab per key press and shows no figure, so it must not
 * stall SLEEP_SETTLE_MS each time.
 */
async function sleepTabs(tabIds, opts) {
  const ids = tabIds || [];
  const measure = !(opts && opts.measure === false);
  const before = measure ? await readMemory() : null;
  let slept = 0;
  let failed = 0;
  const replaced = {};
  const results = await Promise.allSettled(ids.map((id) => chrome.tabs.discard(id)));
  results.forEach((res, i) => {
    const id = ids[i];
    if (res.status === "rejected") {
      failed++;
      LOG("sleep: discard failed for tab", id, ":", res.reason && res.reason.message);
      return;
    }
    const tab = res.value;
    if (!tab) {
      failed++;
      LOG("sleep: discard returned nothing for tab", id);
      return;
    }
    slept++;
    if (tab.id !== id) replaced[id] = tab.id;
  });
  if (slept === 0 || !measure) return { slept, failed, freedBytes: null, replaced };

  await new Promise((r) => setTimeout(r, SLEEP_SETTLE_MS));
  const after = await readMemory();
  const freedBytes = before && after ? after.available - before.available : null;
  return { slept, failed, freedBytes, replaced };
}

/**
 * The overlay cleanup action running now ("sleep-tabs", "dedupe-tabs"), or null. One
 * at a time: a double press, or Dedupe pressed during a Sleep, is ignored.
 */
let overlayActionInFlight = null;

/**
 * Runs one of the overlay's redraw-with-toast cleanup actions (Sleep, Dedupe). `act`
 * gets the live tabs of the window the overlay is on (never the list the overlay
 * rendered, which may be stale) and that window's active tab id, and resolves to the
 * toast result, or null when there was nothing to do. The overlay is redrawn in place
 * on the tab that asked whatever happens, since it shows "Sleeping…" / "Deduping…"
 * until a redraw arrives.
 */
async function runOverlayAction(senderTab, label, act) {
  if (overlayActionInFlight) {
    LOG(label + ":", overlayActionInFlight, "is still running — ignored");
    return;
  }
  overlayActionInFlight = label;
  const refreshTabId = senderTab.id;
  try {
    const windowTabs = await chrome.tabs.query({ windowId: senderTab.windowId });
    const active = windowTabs.find((t) => t.active);
    const result = await act(windowTabs, active ? active.id : senderTab.id);
    if (!result) LOG(label + ": nothing to do in window", senderTab.windowId);
    await showSwitcher(result ? { result, refreshTabId } : { refreshTabId });
  } catch (e) {
    LOG(label + " failed:", e && e.message);
    await showSwitcher({ refreshTabId }).catch((err) => {
      LOG(label + ": refresh after failure failed:", err && err.message);
    });
  } finally {
    overlayActionInFlight = null;
  }
}

/** The overlay's Sleep button / Z key. */
function sleepFromOverlay(senderTab) {
  return runOverlayAction(senderTab, "sleep-tabs", async (windowTabs, activeTabId) => {
    const ids = sleepCandidates(windowTabs, activeTabId);
    if (!ids.length) return null;
    LOG("sleep-tabs: sleeping", ids.length, "tabs:", ids);
    const r = await sleepTabs(ids);
    LOG(
      "sleep-tabs: slept", r.slept, "failed", r.failed,
      "freed", r.freedBytes == null ? "(unknown)" : r.freedBytes + " bytes",
      "replaced", r.replaced
    );
    return { text: sleepToastText(r) };
  });
}

/**
 * The overlay's Dedupe button / D key: closes the copies duplicatePlan picks, then
 * redraws with the toast and its Undo.
 */
function dedupeFromOverlay(senderTab) {
  return runOverlayAction(senderTab, "dedupe-tabs", async (windowTabs, activeTabId) => {
    // Same MRU list showSwitcher ranks with, so the copy kept is the one it promised.
    await ready();
    await reconcileMruList();
    const plan = duplicatePlan(windowTabs, mruList, activeTabId);
    if (!plan.toClose.length) return null;
    LOG("dedupe-tabs: closing", plan.toClose.length, "tabs:", plan.toClose);
    const { batchId, closed } = await closeTabsRecorded(plan.toClose);
    if (!closed) return null;
    const result = { text: dedupeToastText(closed) };
    if (batchId) result.undoBatchId = batchId;
    return result;
  });
}

/**
 * Session key for the closed-tab batches Undo can bring back. Kept in storage rather
 * than a variable because MV3 tears the worker down after ~30 s idle, and an Undo
 * (or a long tidy-up) easily outlives that. Clears when the browser closes.
 */
const TTS_UNDO_BATCHES_SESSION_KEY = "ttsUndoBatches";
/** How many undo batches are kept, newest last; older ones fall off. */
const UNDO_BATCHES_MAX = 20;

/**
 * Serializes read-modify-write of the undo batches, so two closes (or a close and an
 * undo) arriving together cannot overwrite each other's update.
 */
let undoStoreChain = Promise.resolve();
function withUndoStore(fn) {
  const run = undoStoreChain.then(() => fn());
  undoStoreChain = run.catch(() => {});
  return run;
}

async function loadUndoBatches() {
  const data = await chrome.storage.session.get(TTS_UNDO_BATCHES_SESSION_KEY);
  const list = data && data[TTS_UNDO_BATCHES_SESSION_KEY];
  return Array.isArray(list) ? list : [];
}

function newUndoBatchId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Closes the tabs and records them so undoClose can bring them back. Ids that no
 * longer exist are skipped, and each tab is removed on its own, so one that vanishes
 * meanwhile cannot fail the rest; exactly the tabs that closed are recorded, in the
 * order they were closed.
 *
 * Returns { batchId, closed }: batchId is null when nothing closed or the record could
 * not be stored (so no Undo is offered that would find nothing).
 */
async function closeTabsRecorded(tabIds) {
  const ids = [...new Set((tabIds || []).filter((id) => typeof id === "number"))];
  if (!ids.length) return { batchId: null, closed: 0 };

  const found = await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)));
  const live = found.filter(Boolean);
  if (live.length < ids.length) {
    LOG("close: skipping vanished tabs:", ids.filter((id) => !live.some((t) => t.id === id)));
  }
  if (!live.length) return { batchId: null, closed: 0 };

  const results = await Promise.allSettled(live.map((t) => chrome.tabs.remove(t.id)));
  const closedTabs = live.filter((t, i) => {
    if (results[i].status === "fulfilled") return true;
    LOG("close: tab", t.id, "failed:", results[i].reason && results[i].reason.message);
    return false;
  });
  if (!closedTabs.length) return { batchId: null, closed: 0 };

  const records = closedTabs.map((t) => ({
    url: t.url || t.pendingUrl || "",
    index: t.index,
    windowId: t.windowId,
    pinned: !!t.pinned,
  }));
  let batchId = newUndoBatchId();
  try {
    await withUndoStore(async () => {
      const batches = await loadUndoBatches();
      batches.push({ id: batchId, records });
      await chrome.storage.session.set({
        [TTS_UNDO_BATCHES_SESSION_KEY]: batches.slice(-UNDO_BATCHES_MAX),
      });
    });
  } catch (e) {
    // The tabs are closed either way; without a stored record there is nothing to undo.
    LOG("close: storing undo batch failed:", e && e.message);
    batchId = null;
  }
  LOG("closed", closedTabs.length, "tabs, undo batch", batchId);
  return { batchId, closed: closedTabs.length };
}

/**
 * Reopens a record from its recently-closed session, which keeps the back/forward
 * history. Resolves to { ok, tabId }: ok false when the restore failed (the caller then
 * reopens it by URL); tabId null when Chrome restored it without saying as which tab.
 */
async function restoreClosedSession(sessionId) {
  try {
    const session = await chrome.sessions.restore(sessionId);
    const tabId = session && session.tab && session.tab.id != null ? session.tab.id : null;
    LOG("undo: restored session", sessionId, "as tab", tabId == null ? "(unknown)" : tabId);
    return { ok: true, tabId };
  } catch (e) {
    LOG("undo: restore of session", sessionId, "failed:", e && e.message);
    return { ok: false, tabId: null };
  }
}

/**
 * Reopens a record as a fresh background tab at its old place — or anywhere, if that
 * window is gone. Resolves to the new tab id, or null. A record without a URL stays
 * closed rather than coming back as a blank tab.
 */
async function reopenClosedByUrl(rec) {
  if (!rec.url) {
    LOG("undo: record has no URL — not reopened");
    return null;
  }
  const props = { url: rec.url, active: false };
  if (rec.pinned) props.pinned = true;
  const placed = Object.assign({}, props);
  if (typeof rec.windowId === "number") placed.windowId = rec.windowId;
  if (typeof rec.index === "number") placed.index = rec.index;
  try {
    const tab = await chrome.tabs.create(placed);
    LOG("undo: reopened", rec.url, "as tab", tab.id);
    return tab.id;
  } catch (e) {
    LOG("undo: create in window", rec.windowId, "failed:", e && e.message, "— opening it anywhere");
  }
  try {
    const tab = await chrome.tabs.create(props);
    LOG("undo: reopened", rec.url, "as tab", tab.id);
    return tab.id;
  } catch (e) {
    LOG("undo: could not reopen", rec.url, ":", e && e.message);
    return null;
  }
}

/**
 * Brings back a batch closed by closeTabsRecorded. The batch is removed from storage
 * before anything reopens, so a second Undo of it is a no-op.
 *
 * Order matters for where tabs land. The records are in closing order and each session
 * restores at the index it was closed from, so sessions are restored newest-closed
 * first (exact LIFO): every tab then goes back into the strip as it was when it left.
 * Matching runs over the same reversed list, so the newest session of a URL goes to the
 * last-closed copy. Records with no session (or a failed restore) reopen afterwards by
 * URL, in ascending index order.
 *
 * sessions.restore activates the tab it brings back. Activations during the restore are
 * not tracked (see quietActivations), and afterwards each affected window's previously
 * active tab is made active again — but only where the active tab is now one we
 * restored, so a switch the user made meanwhile is left alone.
 *
 * Returns { restored, tabIds }: tabIds[i] is the new id of records[i], or null if it did
 * not come back (or came back as an unknown tab, which still counts as restored).
 */
async function undoClose(batchId) {
  const batch = await withUndoStore(async () => {
    const batches = await loadUndoBatches();
    const i = batches.findIndex((b) => b && b.id === batchId);
    if (i === -1) return null;
    const [taken] = batches.splice(i, 1);
    await chrome.storage.session.set({ [TTS_UNDO_BATCHES_SESSION_KEY]: batches });
    return taken;
  });
  if (!batch) {
    LOG("undo: batch", batchId, "not found (already undone or expired)");
    return { restored: 0, tabIds: [] };
  }
  const records = Array.isArray(batch.records) ? batch.records : [];

  let recentlyClosed = [];
  try {
    recentlyClosed = await chrome.sessions.getRecentlyClosed();
  } catch (e) {
    LOG("undo: getRecentlyClosed failed:", e && e.message);
  }
  // Positions into records, newest-closed first.
  const lifo = records.map((_, i) => i).reverse();
  const sessionIds = matchClosedSessions(lifo.map((i) => records[i]), recentlyClosed);

  const windowIds = [...new Set(records.map((r) => r.windowId).filter((id) => typeof id === "number"))];
  const activeBefore = [];
  for (const windowId of windowIds) {
    try {
      const [active] = await chrome.tabs.query({ active: true, windowId });
      if (active) activeBefore.push({ windowId, tabId: active.id });
    } catch (e) {
      LOG("undo: reading the active tab of window", windowId, "failed:", e && e.message);
    }
  }

  const tabIds = records.map(() => null);
  let restored = 0;
  quietActivations++;
  try {
    const byUrl = [];
    for (let k = 0; k < lifo.length; k++) {
      const i = lifo[k];
      if (!sessionIds[k]) {
        byUrl.push(i);
        continue;
      }
      const r = await restoreClosedSession(sessionIds[k]);
      if (!r.ok) {
        byUrl.push(i);
        continue;
      }
      tabIds[i] = r.tabId;
      restored++;
    }
    byUrl.sort((a, b) => (records[a].index ?? Infinity) - (records[b].index ?? Infinity) || a - b);
    for (const i of byUrl) {
      tabIds[i] = await reopenClosedByUrl(records[i]);
      if (tabIds[i] != null) restored++;
    }

    const ours = new Set(tabIds.filter((id) => id != null));
    for (const { windowId, tabId } of activeBefore) {
      try {
        const [active] = await chrome.tabs.query({ active: true, windowId });
        if (!active || active.id === tabId || !ours.has(active.id)) continue;
        await chrome.tabs.update(tabId, { active: true });
      } catch (e) {
        LOG("undo: handing focus back to tab", tabId, "failed:", e && e.message);
      }
    }
  } finally {
    setTimeout(() => {
      quietActivations--;
    }, QUIET_ACTIVATION_SETTLE_MS);
  }
  LOG("undo: batch", batchId, "restored", restored, "of", records.length, "->", tabIds);
  return { restored, tabIds };
}

/**
 * The tab tidy-up asked to act on, or an answer for the page when it cannot be acted
 * on: { ok:false, gone:true } when it no longer exists (tidy-up then skips it), and
 * { ok:false } for the active tab or a pinned tab, which are never closed or put to
 * sleep whatever the page sent.
 */
async function tidyTarget(tabId, label) {
  if (typeof tabId !== "number") return { answer: { ok: false, error: "no tab id" } };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    LOG(label + ": tab", tabId, "is gone");
    return { answer: { ok: false, gone: true } };
  }
  if (tab.active || tab.pinned) {
    LOG(label + ": refused for tab", tabId, tab.active ? "(active)" : "(pinned)");
    return { answer: { ok: false, error: "the active tab and pinned tabs are left alone" } };
  }
  return { tab };
}

/** After an action did nothing: was that because the tab went away meanwhile? */
async function tidyFailure(tabId, error) {
  const still = await chrome.tabs.get(tabId).catch(() => null);
  return still ? { ok: false, error } : { ok: false, gone: true };
}

/** Tidy-up's X: closes one tab, recorded so U can reopen it. Resolves to { ok, batchId }. */
async function tidyClose(tabId) {
  const { tab, answer } = await tidyTarget(tabId, "tidy-close");
  if (!tab) return answer;
  const { batchId, closed } = await closeTabsRecorded([tab.id]);
  if (!closed) return tidyFailure(tab.id, "the tab could not be closed");
  // batchId is null when the undo record could not be stored: closed, but not undoable.
  return { ok: true, batchId };
}

/**
 * Tidy-up's Z: puts one tab to sleep. Resolves to { ok, newId }, newId being the id the
 * tab has now (Chrome may replace it on discard). No memory reading: one keypress must
 * not wait for one.
 */
async function tidySleep(tabId) {
  const { tab, answer } = await tidyTarget(tabId, "tidy-sleep");
  if (!tab) return answer;
  if (tab.discarded) return { ok: true, newId: tab.id };
  const r = await sleepTabs([tab.id], { measure: false });
  if (!r.slept) return tidyFailure(tab.id, "the tab could not be put to sleep");
  const newId = r.replaced[tab.id] != null ? r.replaced[tab.id] : tab.id;
  return { ok: true, newId };
}

async function showSwitcher(opts) {
  const order = (opts && opts.order) || "mru";
  const refreshTabId = (opts && opts.refreshTabId) != null ? opts.refreshTabId : null;
  await ready();
  const { allTabs, activeTab } = await reconcileMruList();
  if (!activeTab) {
    LOG("no active tab found");
    return;
  }
  // A refresh only redraws the overlay on the tab that asked; if the user has moved
  // on, drawing it elsewhere would reopen a closed overlay.
  if (refreshTabId != null && refreshTabId !== activeTab.id) {
    LOG("refresh: tab", refreshTabId, "is no longer active (", activeTab.id, ") — skipped");
    return;
  }
  LOG("active tab:", activeTab.id, activeTab.url);

  const windowTabs = allTabs.filter((t) => t.windowId === activeTab.windowId);
  LOG("total tabs in window:", windowTabs.length);

  const plan = duplicatePlan(windowTabs, mruList, activeTab.id);
  const sleepCount = sleepCandidates(windowTabs, activeTab.id).length;
  const tidy = tidyQueue(
    windowTabs,
    Object.fromEntries(windowTabs.map((t) => [t.id, lastAccessedOf(t)])),
    activeTab.id
  );

  const tabMap = {};
  for (const tab of windowTabs) {
    tabMap[tab.id] = {
      id: tab.id,
      title: tab.title || "Untitled",
      url: tab.url || "",
      favIconUrl: tab.favIconUrl || "",
      thumbnail: thumbnails[tab.id] || null,
      lastAccessed: lastAccessedOf(tab),
      discarded: !!tab.discarded,
      pinned: !!tab.pinned,
      audible: !!tab.audible,
      dupCount: plan.dupCount[tab.id] || 0,
    };
  }

  let sortedTabs;
  if (order === "index") {
    // Right after a sort the overlay must mirror the tab strip, not the MRU list.
    sortedTabs = windowTabs
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((tab) => tabMap[tab.id]);
  } else {
    sortedTabs = mruList.filter((id) => tabMap[id]).map((id) => tabMap[id]);
    for (const tab of windowTabs) {
      if (!sortedTabs.find((t) => t.id === tab.id)) {
        sortedTabs.push(tabMap[tab.id]);
      }
    }
  }

  const [counts, memory] = await Promise.all([
    tabCounts(allTabs, activeTab.windowId),
    readMemory(),
  ]);
  const memoryText = memoryLineText(memory);
  LOG("sending", sortedTabs.length, "tabs to overlay, thumbnails cached:", Object.keys(thumbnails).length);
  LOG("cleanup: sleep", sleepCount, "dedupe", plan.toClose.length, "tidy", tidy.length, "|", memoryText || "no memory info");

  try {
    await ensureContentScript(activeTab.id);
    await chrome.tabs.sendMessage(activeTab.id, {
      action: "show-switcher",
      tabs: sortedTabs,
      activeTabId: activeTab.id,
      counts,
      armMods: (opts && opts.armMods) || null,
      openedByKey: !!(opts && opts.openedByKey),
      // A redraw of an overlay the page already has: the page drops it if that overlay
      // was closed meanwhile, and never re-arms switch-on-release from it.
      refresh: refreshTabId != null,
      memory,
      memoryText,
      result: (opts && opts.result) || null,
      sleepCount,
      dedupeCount: plan.toClose.length,
      tidyQueue: tidy,
    });
    LOG("show-switcher message sent successfully");
  } catch (e) {
    if (refreshTabId != null) {
      // A refresh must never switch tabs; the overlay is simply gone.
      LOG("refresh: failed to redraw overlay:", e.message);
      return;
    }
    LOG("failed to show overlay:", e.message, "— falling back to direct switch");
    await quickSwitchToPreviousMru();
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
    LOG("content script (overlay) already on tab", tabId);
  } catch {
    LOG("injecting key-gesture + overlay into tab", tabId);
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["debug-helpers.js", "key-gesture.js", "overlay-keys.js", "tidy-mode.js", "content.js"],
    });
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["debug-helpers.js", "key-gesture.js", "overlay-keys.js", "tidy-mode.js"],
    });
  } catch (e) {
    LOG("optional key-gesture re-inject:", e.message);
  }
}

// Toolbar: always open the full thumbnail menu (independent of tap / hold gesture in key-gesture.js).
chrome.action.onClicked.addListener(async (tab) => {
  LOG("toolbar action, tabId:", tab?.id);
  await showSwitcher();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "quick-previous-mru") {
    LOG("command: quick previous MRU (no menu)");
    void quickSwitchToPreviousMru();
    return;
  }
  if (command === "open-tab-switcher") {
    LOG("command: open tab switcher (menu)");
    void advanceOrOpen();
  }
});

/**
 * The modifiers of whatever shortcut is bound to a command right now, read from
 * Chrome rather than guessed from the keyboard.
 *
 * This is the only reliable way to arm "switch on release". The page cannot be asked:
 * Chrome consumes the keydown of its own command chords, so with Ctrl+Shift+Q as the
 * cycle key the page never sees a single keydown with Ctrl held, and if it also missed
 * the bare Ctrl keydown (focus in the browser UI, say) it has no idea anything is being
 * held. Asking Chrome what the chord is sidesteps all of that.
 */
async function triggerMods(commandName) {
  try {
    const all = await chrome.commands.getAll();
    const found = all.find((c) => c.name === commandName);
    const shortcut = (found && found.shortcut) || "";
    if (!shortcut) return null;
    const parts = shortcut.split("+").map((x) => x.trim());
    const named = (name) => parts.indexOf(name) !== -1;
    const glyph = (ch) => shortcut.indexOf(ch) !== -1;
    const mods = {
      // macOS reports Command as "Command" and the real control key as "MacCtrl".
      ctrl: named("Ctrl") || named("MacCtrl") || glyph("\u2303"),
      alt: named("Alt") || named("Option") || glyph("\u2325"),
      shift: named("Shift") || glyph("\u21e7"),
      meta: named("Command") || named("Search") || glyph("\u2318"),
    };
    LOG("trigger mods for", commandName, "from", shortcut, "->", mods);
    return mods;
  } catch (e) {
    LOG("triggerMods failed:", e && e.message);
    return null;
  }
}

/**
 * Chrome reserves Ctrl+Tab for its own tab switching and never dispatches it to a
 * page, so it cannot be the cycle key while Ctrl is held. Tapping the open shortcut
 * again is the cycle instead — Alt+Tab's own gesture, just with Q for Tab — which
 * reaches us through the commands API rather than the page.
 */
async function advanceOrOpen() {
  await ready();
  const armMods = await triggerMods("open-tab-switcher");
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && overlayTabId === activeTab.id) {
    try {
      await chrome.tabs.sendMessage(activeTab.id, {
        action: "advance-selection",
        delta: 1,
        armMods,
        openedByKey: true,
      });
      LOG("advanced selection in tab", activeTab.id);
      return;
    } catch (e) {
      LOG("advance failed, reopening:", e && e.message);
      overlayTabId = null;
    }
  }
  await showSwitcher({ armMods, openedByKey: true });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "overlay-opened") {
    overlayTabId = sender && sender.tab ? sender.tab.id : null;
    LOG("overlay open on tab", overlayTabId);
    return;
  }
  if (message.action === "overlay-closed") {
    if (!sender || !sender.tab || sender.tab.id === overlayTabId) overlayTabId = null;
    LOG("overlay closed");
    return;
  }
  if (message.action === "gesture-open-switcher") {
    void triggerMods("open-tab-switcher").then((armMods) =>
      showSwitcher({ armMods, openedByKey: true })
    );
    return;
  }
  if (message.action === "quick-previous-mru") {
    void quickSwitchToPreviousMru();
    return;
  }
  if (message.action === "sort-tabs") {
    LOG("sort-tabs requested from overlay");
    void sortWindowTabs().then(() => showSwitcher({ order: "index" }));
    return;
  }
  if (message.action === "sleep-tabs") {
    if (!sender || !sender.tab) {
      LOG("sleep-tabs: no sender tab — ignored");
      return;
    }
    LOG("sleep-tabs requested from overlay on tab", sender.tab.id);
    void sleepFromOverlay(sender.tab);
    return;
  }
  if (message.action === "dedupe-tabs") {
    if (!sender || !sender.tab) {
      LOG("dedupe-tabs: no sender tab — ignored");
      return;
    }
    LOG("dedupe-tabs requested from overlay on tab", sender.tab.id);
    void dedupeFromOverlay(sender.tab);
    return;
  }
  if (message.action === "tidy-close" || message.action === "tidy-sleep") {
    // Answers the page (tidy-up) directly — exactly once, errors included — and never
    // redraws it: tidy-up keeps its own card on screen.
    const label = message.action;
    const act = label === "tidy-close" ? tidyClose : tidySleep;
    LOG(label, "requested for tab", message.tabId);
    Promise.resolve()
      .then(() => act(message.tabId))
      .catch((e) => {
        LOG(label + " failed:", e && e.message);
        return { ok: false, error: (e && e.message) || String(e) };
      })
      .then((r) => {
        LOG(label, "tab", message.tabId, "->", r);
        try {
          sendResponse(r);
        } catch (e) {
          LOG(label + ": response failed:", e && e.message);
        }
      });
    return true;
  }
  if (message.action === "undo-close") {
    // Answers too: the caller (tidy-up) needs the new tab ids.
    const refreshTabId = message.refresh && sender && sender.tab ? sender.tab.id : null;
    LOG("undo-close requested for batch", message.batchId);
    undoClose(message.batchId)
      .catch((e) => {
        LOG("undo-close failed:", e && e.message);
        return { restored: 0, tabIds: [], error: (e && e.message) || String(e) };
      })
      .then((r) => {
        try {
          sendResponse(r);
        } catch (e) {
          LOG("undo-close: response failed:", e && e.message);
        }
        if (refreshTabId != null) return showSwitcher({ refreshTabId });
      })
      .catch((e) => {
        LOG("undo-close: refresh failed:", e && e.message);
      });
    return true;
  }
  if (message.action === "refresh-switcher") {
    // Redraw in place: no armMods/openedByKey, so switch-on-release is not re-armed.
    if (overlayActionInFlight) {
      // That action redraws the overlay itself when done; redrawing now would clear
      // its "Sleeping…" / "Deduping…" early.
      LOG("refresh-switcher:", overlayActionInFlight, "is running — it redraws when done");
      return;
    }
    LOG("refresh-switcher requested from overlay");
    void showSwitcher({ refreshTabId: sender && sender.tab ? sender.tab.id : null });
    return;
  }
  if (message.action === "open-options") {
    void chrome.runtime.openOptionsPage().catch((e) => {
      LOG("openOptionsPage failed:", e && e.message);
    });
    return;
  }
  if (message.action === "switch-tab") {
    LOG("switching to tab", message.tabId);
    chrome.tabs.update(message.tabId, { active: true }).catch((e) => {
      LOG("switch-tab failed:", e && e.message);
    });
    if (message.windowId) {
      chrome.windows.update(message.windowId, { focused: true });
    }
  }
});

// Re-read session state as soon as the worker starts, and again on every wake-up
// path (each handler awaits ready()), so no shortcut ever runs against an empty list.
chrome.runtime.onStartup.addListener(() => void ready());
chrome.runtime.onInstalled.addListener(() => void ready());
void ready();
