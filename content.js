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
  let tabCounts = null;
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

  /**
   * Which modifiers are down right now. Tracked continuously, before any overlay
   * exists, because the switcher is built from a message rather than a key event —
   * by then there is no event left to read `ctrlKey` off.
   */
  var heldMods = { ctrl: false, alt: false, shift: false, meta: false };
  /** The modifier whose release commits the selection, or null when not armed. */
  var armedMods = null;

  function readMods(e) {
    return { ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey };
  }

  function trackMods(e) {
    heldMods = readMods(e);
  }
  window.addEventListener("keydown", trackMods, true);
  window.addEventListener("keyup", trackMods, true);

  /**
   * Shift is deliberately never the commit key: it has to stay free to tell "previous"
   * from "next", exactly as Shift+Tab reverses direction under Windows' Alt+Tab.
   */
  function armableFrom(mods) {
    if (!mods.ctrl && !mods.alt && !mods.meta) return null;
    return { ctrl: mods.ctrl, alt: mods.alt, shift: false, meta: mods.meta };
  }

  /**
   * Arms on the first modifier we can see being held — at open time if we caught the
   * keydown, otherwise off the next key the user presses with it still down. Chrome
   * swallows the keydown of its own command shortcuts, so the second path is what
   * makes this work when the switcher was opened from chrome://extensions/shortcuts.
   */
  function armFrom(mods) {
    if (!overlayKeyState.commitOnRelease || armedMods) return;
    var arm = armableFrom(mods);
    if (!arm) return;
    armedMods = arm;
    LOG("release-to-switch armed on", arm);
  }

  /** True when a modifier we armed on has just gone up. */
  function armedModifierReleased(e) {
    if (!armedMods) return false;
    var now = readMods(e);
    return (
      (armedMods.ctrl && !now.ctrl) ||
      (armedMods.alt && !now.alt) ||
      (armedMods.meta && !now.meta)
    );
  }

  /**
   * Key matching that looks past whatever modifier is armed. The user is holding it
   * down on purpose, so Ctrl+Tab has to still register as the plain "next" binding.
   */
  function matchKey(e, spec) {
    if (!armedMods) return OK.match(e, spec);
    if (e.key !== spec.k) return false;
    if (e.shiftKey !== !!spec.shift) return false;
    if (!armedMods.ctrl && e.ctrlKey !== !!spec.ctrl) return false;
    if (!armedMods.alt && e.altKey !== !!spec.alt) return false;
    if (!armedMods.meta && e.metaKey !== !!spec.meta) return false;
    return true;
  }

  /** A bare key press — no modifiers beyond the armed one, which we ignore. */
  function isBareKey(e, keys) {
    if (keys.indexOf(e.key) === -1 || e.shiftKey) return false;
    if (e.ctrlKey && !(armedMods && armedMods.ctrl)) return false;
    if (e.altKey && !(armedMods && armedMods.alt)) return false;
    if (e.metaKey && !(armedMods && armedMods.meta)) return false;
    return true;
  }

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

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  /**
   * Fills the header's tab-count pill. The window count is taken from the list we were
   * handed so it can never disagree with the rows on screen; the cross-window total
   * only appears when there is more than one window to talk about.
   */
  function paintCounts(overlay) {
    const el = overlay.querySelector(".tts-header-count");
    const extra = overlay.querySelector(".tts-header-total");
    if (!el) {
      LOG("paintCounts: no count element under the overlay yet");
      return;
    }

    const inWindow = tabList.length;
    el.textContent = plural(inWindow, "tab");

    const total = tabCounts && tabCounts.total;
    const windows = tabCounts && tabCounts.windows;
    if (extra) {
      const showTotal = windows > 1 && total > inWindow;
      extra.textContent = showTotal ? plural(total, "tab") + " in " + plural(windows, "window") : "";
      extra.hidden = !showTotal;
    }
    el.title = plural(inWindow, "tab") + " in this window";
    if (windows > 1) el.title += ", " + plural(total, "tab") + " across " + plural(windows, "window");
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
  function updateTabs(overlay, tabs, activeTabId, counts) {
    const keepId = tabList[selectedIndex] && tabList[selectedIndex].id;
    tabList = tabs;
    currentTabId = activeTabId;
    tabCounts = counts || tabCounts;
    const i = tabList.findIndex((t) => t.id === keepId);
    selectedIndex = i >= 0 ? i : 0;
    const list = overlay.querySelector(".tts-list");
    renderList(list);
    paintCounts(overlay);
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

  function buildOverlay(tabs, activeTabId, counts) {
    LOG("building overlay with", tabs.length, "tabs");
    removeOverlay();
    tabList = tabs;
    currentTabId = activeTabId;
    tabCounts = counts || null;
    selectedIndex = tabs.length > 1 ? 1 : 0;
    armedMods = null;
    armFrom(heldMods);

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

    const topLine = document.createElement("div");
    topLine.className = "tts-header-line";

    const title = document.createElement("span");
    title.className = "tts-header-title";
    title.textContent = "Switch Tab";
    topLine.appendChild(title);

    const count = document.createElement("span");
    count.className = "tts-header-count";
    topLine.appendChild(count);

    headerMain.appendChild(topLine);

    const subLine = document.createElement("div");
    subLine.className = "tts-header-line";

    let verText = "";
    try {
      verText = chrome.runtime.getManifest().version || "";
    } catch (e) {}
    if (verText) {
      const ver = document.createElement("span");
      ver.className = "tts-header-version";
      ver.textContent = "v" + verText;
      subLine.appendChild(ver);
    }

    const total = document.createElement("span");
    total.className = "tts-header-total";
    total.hidden = true;
    subLine.appendChild(total);

    headerMain.appendChild(subLine);

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
    // After the container is attached — paintCounts looks the pill up through `overlay`.
    paintCounts(overlay);
    document.documentElement.appendChild(overlay);

    requestAnimationFrame(() => {
      overlay.classList.add("tts-visible");
      scrollSelectedIntoView(list);
    });

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
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
    armFrom(readMods(e));

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

    if (matchKey(e, k.close)) {
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      LOG("close key pressed, removing overlay");
      removeOverlay();
      return;
    }
    if (matchKey(e, k.switch)) {
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      LOG("switch key pressed, tab", tabList[selectedIndex] && tabList[selectedIndex].id);
      if (tabList[selectedIndex]) switchToTab(tabList[selectedIndex].id);
      return;
    }
    if (matchKey(e, k.prev)) {
      goPrev();
      return;
    }
    if (matchKey(e, k.next)) {
      goNext();
      return;
    }
    if (k.alsoArrows && isBareKey(e, ["ArrowDown"])) {
      goNext();
      return;
    }
    if (k.alsoArrows && isBareKey(e, ["ArrowUp"])) {
      goPrev();
      return;
    }
    // Reached only when the configured keys above did not claim the event, so a user
    // who rebinds navigation to S keeps that binding.
    if (isBareKey(e, ["s", "S"])) {
      if (e.repeat) return;
      e.preventDefault();
      e.stopPropagation();
      requestSort();
      return;
    }
  }

  /**
   * Windows' Alt+Tab commits when you let the modifier go; this does the same. Only
   * ever reached while the overlay is open, and only arms/commits when the option is
   * on, so with it off this is two boolean reads per keyup.
   */
  function handleKeyUp(e) {
    if (!document.getElementById(OVERLAY_ID)) return;
    if (!overlayKeyState.commitOnRelease) return;

    if (armedModifierReleased(e)) {
      e.preventDefault();
      e.stopPropagation();
      const tab = tabList[selectedIndex];
      LOG("armed modifier released, switching to", tab && tab.id);
      if (tab) switchToTab(tab.id);
      else removeOverlay();
      return;
    }
    // Releasing a non-modifier (the Q of Ctrl+Shift+Q, say) still tells us what is
    // being held, which is the only signal we get when Chrome ate the keydown.
    armFrom(readMods(e));
  }

  function switchToTab(tabId) {
    LOG("requesting switch to tab", tabId);
    chrome.runtime.sendMessage({ action: "switch-tab", tabId });
    removeOverlay();
  }

  function removeOverlay() {
    document.removeEventListener("keydown", handleKeyDown, true);
    document.removeEventListener("keyup", handleKeyUp, true);
    armedMods = null;
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
    tabCounts = null;
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
      if (open) updateTabs(open, message.tabs, message.activeTabId, message.counts);
      else buildOverlay(message.tabs, message.activeTabId, message.counts);
    }
  });
})();
