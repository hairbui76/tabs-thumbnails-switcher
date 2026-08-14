(() => {
  const ttsCreate = typeof self.__ttsCreateTtsLog === "function" ? self.__ttsCreateTtsLog : function () { return function () {}; };
  const LOG = ttsCreate("content");

  if (window.__ttsInjected) {
    LOG("already injected, skipping");
    return;
  }
  window.__ttsInjected = true;
  LOG("content script loaded on", location.href);

  const okg = self;
  const OK = {
    sk: okg.TTS_STORAGE_KEY_OVERLAY_KEYS,
    merge: okg.TTS_mergeOverlayKeys,
    match: okg.TTS_keyMatches,
    hint: okg.TTS_hintHtml,
  };

  const OVERLAY_ID = "tts-overlay";
  const SORT_TITLE =
    "Sort tabs — the 10 most recently visited first, then grouped by site, title, visit time. Also reorders the real Chrome tabs.";

  let selectedIndex = 0;
  let tabList = [];
  let currentTabId = null;
  var overlayKeyState = OK.merge(null);

  function pullOverlayKeys() {
    var q = {};
    q[OK.sk] = null;
    try {
      chrome.storage.local.get(q, function (s) {
        overlayKeyState = OK.merge(s[OK.sk]);
        LOG("overlay key bindings updated");
      });
    } catch (e) {
      LOG("overlay keys get failed", e);
    }
  }
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "local" && changes[OK.sk]) {
        overlayKeyState = OK.merge(changes[OK.sk].newValue);
      }
    });
  } catch (e) {}
  pullOverlayKeys();

  function getDomain(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  function formatVisited(ms) {
    if (!ms) return "";
    const diff = Date.now() - ms;
    if (diff < 60000) return "just now";
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + "m ago";
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h ago";
    return Math.floor(hours / 24) + "d ago";
  }

  function requestSort() {
    LOG("requesting tab sort");
    try {
      chrome.runtime.sendMessage({ action: "sort-tabs" });
    } catch (e) {
      LOG("sort request failed", e);
    }
  }

  function renderList(list) {
    list.textContent = "";

    tabList.forEach((tab, i) => {
      const card = document.createElement("div");
      card.className = "tts-card" + (i === selectedIndex ? " tts-selected" : "");
      if (tab.id === currentTabId) card.classList.add("tts-current");
      card.dataset.index = i;

      const info = document.createElement("div");
      info.className = "tts-card-info";

      const favicon = document.createElement("img");
      favicon.className = "tts-favicon";
      favicon.src = tab.favIconUrl || "";
      favicon.alt = "";
      favicon.onerror = () => {
        favicon.style.display = "none";
      };
      info.appendChild(favicon);

      const textBlock = document.createElement("div");
      textBlock.className = "tts-text";

      const title = document.createElement("div");
      title.className = "tts-title";
      title.textContent = tab.title;
      textBlock.appendChild(title);

      const domain = document.createElement("div");
      domain.className = "tts-domain";
      domain.textContent = getDomain(tab.url);
      const visited = formatVisited(tab.lastAccessed);
      if (visited) {
        const stamp = document.createElement("span");
        stamp.className = "tts-visited";
        stamp.textContent = visited;
        domain.appendChild(stamp);
      }
      textBlock.appendChild(domain);

      info.appendChild(textBlock);
      card.appendChild(info);

      if (tab.thumbnail) {
        const thumb = document.createElement("img");
        thumb.className = "tts-thumbnail";
        thumb.src = tab.thumbnail;
        thumb.alt = "Tab preview";
        card.appendChild(thumb);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "tts-thumbnail-placeholder";
        placeholder.textContent = "No preview";
        card.appendChild(placeholder);
      }

      card.addEventListener("click", () => {
        switchToTab(tab.id);
      });

      card.addEventListener("mouseenter", () => {
        selectedIndex = i;
        updateSelection(list);
      });

      list.appendChild(card);
    });
  }

  /** Refresh an already-open overlay in place (used after a sort) — no rebuild flash. */
  function updateTabs(overlay, tabs, activeTabId) {
    const keepId = tabList[selectedIndex] && tabList[selectedIndex].id;
    tabList = tabs;
    currentTabId = activeTabId;
    const i = tabList.findIndex((t) => t.id === keepId);
    selectedIndex = i >= 0 ? i : 0;
    const list = overlay.querySelector(".tts-list");
    renderList(list);
    scrollSelectedIntoView(list);
    LOG("overlay list refreshed, selected index:", selectedIndex);
  }

  function buildHeaderButton(className, label, svg, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    btn.innerHTML = svg;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      // Keep DOM focus off the button so Space cannot re-trigger it behind the overlay's
      // own key handling.
      btn.blur();
      onClick();
    });
    return btn;
  }

  function buildOverlay(tabs, activeTabId) {
    LOG("building overlay with", tabs.length, "tabs");
    removeOverlay();
    tabList = tabs;
    currentTabId = activeTabId;
    selectedIndex = tabs.length > 1 ? 1 : 0;

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) removeOverlay();
    });

    const container = document.createElement("div");
    container.className = "tts-container";

    const header = document.createElement("div");
    header.className = "tts-header";

    const headerMain = document.createElement("div");
    headerMain.className = "tts-header-main";

    const title = document.createElement("span");
    title.className = "tts-header-title";
    title.textContent = "Switch Tab";
    headerMain.appendChild(title);

    let verText = "";
    try {
      verText = chrome.runtime.getManifest().version || "";
    } catch (e) {}
    if (verText) {
      const ver = document.createElement("span");
      ver.className = "tts-header-version";
      ver.textContent = "v" + verText;
      headerMain.appendChild(ver);
    }

    header.appendChild(headerMain);

    const actions = document.createElement("div");
    actions.className = "tts-header-actions";

    actions.appendChild(
      buildHeaderButton(
        "tts-header-btn tts-header-sort",
        SORT_TITLE,
        '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/></svg>',
        requestSort
      )
    );

    actions.appendChild(
      buildHeaderButton(
        "tts-header-btn tts-header-settings",
        "Settings",
        '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
        () => {
          LOG("open settings from overlay");
          removeOverlay();
          try {
            chrome.runtime.sendMessage({ action: "open-options" });
          } catch (err) {
            LOG("open options message failed", err);
          }
        }
      )
    );

    header.appendChild(actions);
    container.appendChild(header);

    const list = document.createElement("div");
    list.className = "tts-list";
    renderList(list);
    container.appendChild(list);

    const hint = document.createElement("div");
    hint.className = "tts-hint";
    hint.innerHTML =
      OK.hint(overlayKeyState) + ' &nbsp; <span class="tts-key">S</span> sort tabs';
    container.appendChild(hint);

    overlay.appendChild(container);
    document.documentElement.appendChild(overlay);

    requestAnimationFrame(() => {
      overlay.classList.add("tts-visible");
      scrollSelectedIntoView(list);
    });

    document.addEventListener("keydown", handleKeyDown, true);
    LOG("overlay shown, selected index:", selectedIndex);
  }

  function updateSelection(list) {
    const cards = list.querySelectorAll(".tts-card");
    cards.forEach((card, i) => {
      card.classList.toggle("tts-selected", i === selectedIndex);
    });
    scrollSelectedIntoView(list);
  }

  function scrollSelectedIntoView(list) {
    const selected = list.querySelector(".tts-selected");
    if (selected) {
      selected.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function handleKeyDown(e) {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;

    const list = overlay.querySelector(".tts-list");
    const k = overlayKeyState;

    function goPrev() {
      e.preventDefault();
      e.stopPropagation();
      selectedIndex = (selectedIndex - 1 + tabList.length) % tabList.length;
      LOG("navigate: prev -> index", selectedIndex);
      updateSelection(list);
    }
    function goNext() {
      e.preventDefault();
      e.stopPropagation();
      selectedIndex = (selectedIndex + 1) % tabList.length;
      LOG("navigate: next -> index", selectedIndex);
      updateSelection(list);
    }

    if (OK.match(e, k.close)) {
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      LOG("close key pressed, removing overlay");
      removeOverlay();
      return;
    }
    if (OK.match(e, k.switch)) {
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      LOG("switch key pressed, tab", tabList[selectedIndex] && tabList[selectedIndex].id);
      if (tabList[selectedIndex]) switchToTab(tabList[selectedIndex].id);
      return;
    }
    if (OK.match(e, k.prev)) {
      goPrev();
      return;
    }
    if (OK.match(e, k.next)) {
      goNext();
      return;
    }
    if (k.alsoArrows && e.key === "ArrowDown" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      goNext();
      return;
    }
    if (k.alsoArrows && e.key === "ArrowUp" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      goPrev();
      return;
    }
    // Reached only when the configured keys above did not claim the event, so a user
    // who rebinds navigation to S keeps that binding.
    if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      requestSort();
      return;
    }
  }

  function switchToTab(tabId) {
    LOG("requesting switch to tab", tabId);
    chrome.runtime.sendMessage({ action: "switch-tab", tabId });
    removeOverlay();
  }

  function removeOverlay() {
    document.removeEventListener("keydown", handleKeyDown, true);
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      overlay.classList.remove("tts-visible");
      overlay.addEventListener("transitionend", () => overlay.remove(), {
        once: true,
      });
      setTimeout(() => overlay.remove(), 200);
      LOG("overlay removed");
    }
    tabList = [];
    selectedIndex = 0;
    currentTabId = null;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "ping") {
      LOG("ping received");
      sendResponse({ ok: true });
      return;
    }
    if (message.action === "show-switcher") {
      LOG("show-switcher received with", message.tabs.length, "tabs");
      const open = document.getElementById(OVERLAY_ID);
      if (open) updateTabs(open, message.tabs, message.activeTabId);
      else buildOverlay(message.tabs, message.activeTabId);
    }
  });
})();
