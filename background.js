importScripts("debug-helpers.js");
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

function setToolbarTitleWithVersion() {
  try {
    const v = chrome.runtime.getManifest().version;
    const base = "Open tab switcher (thumbnail menu)";
    chrome.action.setTitle({ title: v ? base + " · v" + v : base });
  } catch (e) {
    LOG("setToolbarTitleWithVersion:", e && e.message);
  }
}

async function initMruList() {
  LOG("initializing...");
  setToolbarTitleWithVersion();
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

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { tabId, windowId } = activeInfo;
  LOG("tab activated:", tabId, "window:", windowId);

  await ready();
  mruList = [tabId, ...mruList.filter((id) => id !== tabId)];
  lastAccessed[tabId] = Date.now();
  await saveMruList();

  captureTab(windowId, tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  LOG("tab removed:", tabId);
  await ready();
  mruList = mruList.filter((id) => id !== tabId);
  delete thumbnails[tabId];
  delete lastAccessed[tabId];
  await saveMruList();
  await persistThumbnails();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  LOG("tab created:", tab.id);
  await ready();
  if (!mruList.includes(tab.id)) {
    mruList.push(tab.id);
    await saveMruList();
  }
});

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

async function showSwitcher(opts) {
  const order = (opts && opts.order) || "mru";
  await ready();
  const { allTabs, activeTab } = await reconcileMruList();
  if (!activeTab) {
    LOG("no active tab found");
    return;
  }
  LOG("active tab:", activeTab.id, activeTab.url);

  const windowTabs = allTabs.filter((t) => t.windowId === activeTab.windowId);
  LOG("total tabs in window:", windowTabs.length);

  const tabMap = {};
  for (const tab of windowTabs) {
    tabMap[tab.id] = {
      id: tab.id,
      title: tab.title || "Untitled",
      url: tab.url || "",
      favIconUrl: tab.favIconUrl || "",
      thumbnail: thumbnails[tab.id] || null,
      lastAccessed: lastAccessedOf(tab),
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

  LOG("sending", sortedTabs.length, "tabs to overlay, thumbnails cached:", Object.keys(thumbnails).length);

  try {
    await ensureContentScript(activeTab.id);
    await chrome.tabs.sendMessage(activeTab.id, {
      action: "show-switcher",
      tabs: sortedTabs,
      activeTabId: activeTab.id,
    });
    LOG("show-switcher message sent successfully");
  } catch (e) {
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
      files: ["debug-helpers.js", "key-gesture.js", "overlay-keys.js", "content.js"],
    });
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["debug-helpers.js", "key-gesture.js", "overlay-keys.js"],
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
    void showSwitcher();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "gesture-open-switcher") {
    void showSwitcher();
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
