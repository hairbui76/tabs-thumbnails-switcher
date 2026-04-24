importScripts("debug-helpers.js");
const LOG = self.__ttsCreateTtsLog("background");

/** Session key for JPEG data URLs; survives MV3 service worker sleep, clears when browser closes. */
const TTS_THUMBNAILS_SESSION_KEY = "ttsTabThumbnails";

let mruList = [];
let thumbnails = {};
let captureTimer = null;

async function saveMruList() {
  try {
    await chrome.storage.session.set({ mruList });
  } catch (e) {
    LOG("saveMruList error:", e.message);
  }
}

async function loadMruList() {
  try {
    const data = await chrome.storage.session.get(["mruList", TTS_THUMBNAILS_SESSION_KEY]);
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
  } catch (e) {
    LOG("loadMruList error:", e.message);
  }
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
  await loadMruList();
  if (mruList.length === 0) {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const activeTab = tabs.find((t) => t.active);
    mruList = tabs.map((t) => t.id);
    if (activeTab) {
      mruList = [activeTab.id, ...mruList.filter((id) => id !== activeTab.id)];
    }
    await saveMruList();
    LOG("built initial MRU list:", mruList);
  }
  LOG("ready");
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

  mruList = [tabId, ...mruList.filter((id) => id !== tabId)];
  await saveMruList();

  captureTab(windowId, tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  LOG("tab removed:", tabId);
  mruList = mruList.filter((id) => id !== tabId);
  delete thumbnails[tabId];
  await saveMruList();
  await persistThumbnails();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  LOG("tab created:", tab.id);
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

function quickSwitchToPreviousMru() {
  if (mruList.length < 2) {
    LOG("quick-mru: need at least 2 tabs");
    return;
  }
  const prev = mruList[1];
  LOG("quick-mru: switch to", prev);
  chrome.tabs.update(prev, { active: true });
}

async function showSwitcher() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!activeTab) {
    LOG("no active tab found");
    return;
  }
  LOG("active tab:", activeTab.id, activeTab.url);

  const allTabs = await chrome.tabs.query({ currentWindow: true });
  LOG("total tabs in window:", allTabs.length);

  const tabMap = {};
  for (const tab of allTabs) {
    tabMap[tab.id] = {
      id: tab.id,
      title: tab.title || "Untitled",
      url: tab.url || "",
      favIconUrl: tab.favIconUrl || "",
      thumbnail: thumbnails[tab.id] || null,
    };
  }

  const sortedTabs = mruList
    .filter((id) => tabMap[id])
    .map((id) => tabMap[id]);

  for (const tab of allTabs) {
    if (!sortedTabs.find((t) => t.id === tab.id)) {
      sortedTabs.push(tabMap[tab.id]);
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
    if (mruList.length >= 2) {
      chrome.tabs.update(mruList[1], { active: true });
    }
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
    quickSwitchToPreviousMru();
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
  if (message.action === "open-options") {
    void chrome.runtime.openOptionsPage().catch((e) => {
      LOG("openOptionsPage failed:", e && e.message);
    });
    return;
  }
  if (message.action === "switch-tab") {
    LOG("switching to tab", message.tabId);
    chrome.tabs.update(message.tabId, { active: true });
    if (message.windowId) {
      chrome.windows.update(message.windowId, { focused: true });
    }
  }
});

initMruList();
