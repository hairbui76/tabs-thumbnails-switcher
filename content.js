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
  /**
   * Marks an overlay that is fading out. It keeps its id (all of content.css hangs off
   * #tts-overlay, so dropping the id would unstyle it mid-fade), but findOverlay skips
   * it so nothing arriving during the fade updates a dying overlay.
   */
  const CLOSING_CLASS = "tts-closing";

  /** The live overlay, or null — never one that is fading out. */
  function findOverlay() {
    return document.querySelector("#" + OVERLAY_ID + ":not(." + CLOSING_CLASS + ")");
  }
  const SORT_TITLE =
    "Sort tabs — the 10 most recently visited first, then grouped by site, title, visit time. Also reorders the real Chrome tabs.";
  const SLEEP_EXCLUDED = "The current tab, pinned tabs and tabs playing sound stay awake.";
  // Shared with tidy-mode.js, which is loaded first (manifest and ensureContentScript);
  // the literal only covers a page where it somehow is not.
  const ASLEEP_TITLE =
    (self.TTS_tidy && self.TTS_tidy.ASLEEP_TITLE) || "Asleep — reloads when you open it";
  const DEDUPE_RULE =
    "Copies of a page (ignoring #anchors) in this window. The current tab, else a pinned one, else the most recently used copy stays open.";
  const TIDY_TITLE =
    "Go through this window's tabs one at a time, least recently visited first (T): close, keep or put each to sleep.";
  /** Tidy-up's letters (and T, which opens it): swallowed under tidy-up even with modifiers. */
  const TIDY_LETTERS = ["x", "k", "z", "u", "t"];
  /** How long a result toast stays up. */
  const TOAST_MS = 8000;

  let selectedIndex = 0;
  let tabList = [];
  let currentTabId = null;
  let tabCounts = null;
  /** Cleanup figures from the latest show-switcher payload, precomputed by the worker. */
  let sleepCount = 0;
  let dedupeCount = 0;
  let memoryText = "";
  let toastTimer = null;
  /**
   * The cleanup action whose request is out — null, "sleep" or "dedupe". One at a
   * time; cleared by the redraw that answers it.
   */
  let pendingAction = null;
  /** Tab ids for tidy-up, least recently visited first, from the latest payload. */
  let tidyQueueIds = [];
  /**
   * The mounted tidy-up view ({ handleKey, exit, replaceId, destroy }, from
   * TTS_tidy.mount) and its element, or null.
   */
  let tidy = null;
  let tidyEl = null;
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
  /** The modifier whose release commits the selection, or null when not identified. */
  var armedMods = null;
  /**
   * Whether the switcher was opened from the keyboard, so the user is presumably still
   * holding something. This, not armedMods, is what gates the commit: identifying the
   * exact chord is best-effort, and gating on it meant that whenever identification
   * failed the gesture silently did nothing at all.
   */
  var openedByKey = false;
  /**
   * Set by a cleanup action (Z, D or their buttons): stay disarmed until every
   * modifier is up, so the keyup of a Ctrl+Z cannot re-arm on the still-held Ctrl and
   * have its release switch to a tab that is being put to sleep or closed.
   */
  var disarmedUntilRelease = false;

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
   * Arms the release gesture. `mods` is normally the modifier set the worker read off
   * the bound shortcut, which is the only source that can be trusted: Chrome consumes
   * the keydown of its own command chords, so with Ctrl+Shift+Q as the cycle key this
   * page never sees a keydown with Ctrl held, however hard it watches the keyboard.
   * Observed keyboard state is kept as a fallback for the in-page paths.
   */
  function armFrom(mods) {
    // Stay disarmed while a cleanup action runs or tidy-up is open, and after either
    // until the keys are let go.
    if (!overlayKeyState.commitOnRelease || armedMods || pendingAction || tidy || disarmedUntilRelease) return;
    var arm = armableFrom(mods || heldMods);
    if (!arm) return;
    armedMods = arm;
    LOG("release-to-switch armed on", arm);
  }

  /** True when a modifier we identified has just gone up. */
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
   * Any modifier going up, whichever it is. Shift is left out on purpose: it stays
   * free to reverse direction, and the trigger chords hold it down anyway.
   */
  function isCommitModifier(key) {
    return key === "Control" || key === "Alt" || key === "Meta" || key === "OS";
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

  /**
   * A bare key press — no modifiers beyond the armed one, which we ignore.
   *
   * `allowArmedShift` also forgives Shift while armed, for keys that carry their own
   * direction. The trigger chord is usually Ctrl+Shift+Q, so Shift is down for
   * everything the user presses; refusing it would leave the arrows dead until they
   * let Shift go, even though up and down need no Shift to tell them apart.
   */
  function isBareKey(e, keys, allowArmedShift) {
    if (keys.indexOf(e.key) === -1) return false;
    if (e.shiftKey && !(allowArmedShift && armedMods)) return false;
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

  /** Takes the cleanup figures off a show-switcher payload into module state. */
  function applyPayload(message) {
    sleepCount = message.sleepCount || 0;
    dedupeCount = message.dedupeCount || 0;
    memoryText = message.memoryText || "";
    tidyQueueIds = Array.isArray(message.tidyQueue) ? message.tidyQueue.slice() : [];
    pendingAction = null;
  }

  /** Fills the header's memory line and the Sleep N / Dedupe N buttons from module state. */
  function paintCleanup(overlay) {
    const mem = overlay.querySelector(".tts-header-memory");
    if (mem) {
      mem.textContent = memoryText;
      mem.hidden = !memoryText;
    }
    // While one action runs the other button is disabled too: one cleanup at a time.
    const busy = "Wait for the current cleanup to finish.";
    const tidying = "Leave tidy-up first (Esc).";
    const sleep = overlay.querySelector(".tts-header-sleep");
    if (sleep) {
      sleep.textContent = pendingAction === "sleep" ? "Sleeping…" : "Sleep " + sleepCount;
      sleep.disabled = pendingAction !== null || !!tidy || sleepCount === 0;
      sleep.title =
        pendingAction === "sleep"
          ? "Putting tabs to sleep…"
          : pendingAction
            ? busy
            : tidy
              ? tidying
              : sleepCount === 0
                ? "Nothing to put to sleep — the other tabs are asleep already or must stay awake. " + SLEEP_EXCLUDED
                : "Put " + plural(sleepCount, "background tab") + " to sleep to free memory (Z). They reload when you open them. " + SLEEP_EXCLUDED;
    }
    const dedupe = overlay.querySelector(".tts-header-dedupe");
    if (dedupe) {
      dedupe.textContent = pendingAction === "dedupe" ? "Deduping…" : "Dedupe " + dedupeCount;
      dedupe.hidden = pendingAction !== "dedupe" && dedupeCount === 0;
      dedupe.disabled = pendingAction !== null || !!tidy;
      dedupe.title =
        pendingAction === "dedupe"
          ? "Closing duplicate tabs…"
          : pendingAction
            ? busy
            : tidy
              ? tidying
              : "Close " + plural(dedupeCount, "duplicate tab") + " (D). Undo brings them back. " + DEDUPE_RULE;
    }
    const tidyBtn = overlay.querySelector(".tts-header-tidy");
    if (tidyBtn) {
      tidyBtn.disabled = pendingAction !== null || !!tidy;
      tidyBtn.title = pendingAction ? busy : tidy ? "Tidy-up is open" : TIDY_TITLE;
    }
  }

  /**
   * The key legend under the list. Rebuilt on every draw so later cleanup keys can be
   * shown only when they have something to do.
   */
  function paintHint(overlay) {
    const hint = overlay.querySelector(".tts-hint");
    if (!hint) return;
    hint.innerHTML =
      OK.hint(overlayKeyState) +
      ' &nbsp; <span class="tts-key">S</span> sort tabs' +
      ' &nbsp; <span class="tts-key">Z</span> sleep' +
      (dedupeCount > 0 ? ' &nbsp; <span class="tts-key">D</span> dedupe' : "") +
      ' &nbsp; <span class="tts-key">T</span> tidy up';
  }

  /**
   * A result line at the bottom of the switcher (after Sleep, say), floating just above
   * the key legend. Replaces any toast already up and hides itself after TOAST_MS. When
   * the result carries an undo batch (after Dedupe) it gets an Undo button, which hides
   * the toast at once; the worker's redraw then brings the reopened tabs into the list.
   */
  function showToast(overlay, result) {
    if (!overlay || !result || !result.text) return;
    const anchor = overlay.querySelector(".tts-toast-anchor");
    if (!anchor) {
      LOG("showToast: no toast anchor under the overlay");
      return;
    }
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    anchor.textContent = "";

    const toast = document.createElement("div");
    toast.className = "tts-toast";
    toast.setAttribute("role", "status");
    const text = document.createElement("span");
    text.className = "tts-toast-text";
    text.textContent = result.text;
    toast.appendChild(text);
    if (result.undoBatchId) {
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "tts-toast-undo";
      undo.textContent = "Undo";
      undo.dataset.batchId = result.undoBatchId;
      let undoSent = false;
      undo.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        undo.blur();
        if (undoSent) return;
        undoSent = true;
        hideToast(toast);
        requestUndo(undo.dataset.batchId);
      });
      toast.appendChild(undo);
    }
    anchor.appendChild(toast);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toast.remove();
    }, TOAST_MS);
    LOG("toast:", result.text, result.undoBatchId ? "(undo " + result.undoBatchId + ")" : "");
  }

  /** Takes a toast down now; its timer goes too unless a newer toast already owns it. */
  function hideToast(toast) {
    if (!toast.isConnected) return;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    toast.remove();
  }

  /** Reopens a closed batch; the worker answers with a redraw of this overlay. */
  function requestUndo(batchId) {
    LOG("requesting undo of batch", batchId);
    askWorker({ action: "undo-close", batchId: batchId, refresh: true }).then(
      (res) => LOG("undo-close restored", res && res.restored, res && res.error ? "error: " + res.error : ""),
      (e) => LOG("undo-close failed:", e && e.message)
    );
  }

  /** A worker request that is answered: resolves to the answer, rejects on a send error. */
  function askWorker(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function tellWorker(action) {
    try {
      chrome.runtime.sendMessage({ action: action });
    } catch (e) {
      LOG(action + " message failed", e);
    }
  }

  /** Moves the selection by delta, wrapping. Shared by the keys and the open shortcut. */
  function advanceSelection(overlay, delta) {
    if (!tabList.length) return;
    selectedIndex = (selectedIndex + delta + tabList.length) % tabList.length;
    LOG("advance selection by", delta, "-> index", selectedIndex);
    updateSelection(overlay.querySelector(".tts-list"));
  }

  function requestSort() {
    LOG("requesting tab sort");
    try {
      chrome.runtime.sendMessage({ action: "sort-tabs" });
    } catch (e) {
      LOG("sort request failed", e);
    }
  }

  /** The redraw-with-toast cleanup actions, by name: worker message and current count. */
  const CLEANUP_ACTIONS = {
    sleep: { message: "sleep-tabs", count: () => sleepCount },
    dedupe: { message: "dedupe-tabs", count: () => dedupeCount },
  };

  /**
   * Asks the worker for a cleanup action (Sleep, Dedupe). The worker recomputes what to
   * do from live tabs; the count only gates the request. Refused while another action
   * is out.
   */
  function requestCleanup(kind) {
    const action = CLEANUP_ACTIONS[kind];
    if (pendingAction) {
      LOG(kind + ": refused —", pendingAction, "is still running");
      return;
    }
    if (tidy) {
      LOG(kind + ": refused — tidy-up is open");
      return;
    }
    const count = action.count();
    if (count === 0) {
      LOG(kind + ": nothing to do");
      return;
    }
    // With switch-on-release armed, letting go of Ctrl after Ctrl+Z / Ctrl+D would
    // switch to — and reload — a tab that is being put to sleep or closed.
    armedMods = null;
    openedByKey = false;
    disarmedUntilRelease = true;
    pendingAction = kind;
    const overlay = findOverlay();
    if (overlay) paintCleanup(overlay);
    LOG("requesting", kind, "of", count, "tabs (release-to-switch disarmed)");
    tellWorker(action.message);
  }

  /**
   * Replaces the list with tidy-up (tidy-mode.js), on the queue from the latest payload.
   * Refused while a cleanup action is out. Disarms switch-on-release first, so letting go
   * of Ctrl mid-triage cannot switch tabs.
   */
  function enterTidy(overlay) {
    if (!overlay || tidy) return;
    if (pendingAction) {
      LOG("tidy-up: refused —", pendingAction, "is still running");
      return;
    }
    const container = overlay.querySelector(".tts-container");
    const el = document.createElement("div");
    el.className = "tts-tidy";
    container.insertBefore(el, overlay.querySelector(".tts-toast-anchor"));
    try {
      // Looked up now, not at load; a missing tidy-mode.js lands in the catch below.
      tidy = self.TTS_tidy.mount({
        container: el,
        tabs: tabList,
        queue: tidyQueueIds,
        send: askWorker,
        onExit: () => exitTidy(true),
        onSwitch: (tabId) => switchToTab(tabId),
        domainOf: getDomain,
        visitedOf: formatVisited,
      });
    } catch (e) {
      // The list stays as it was.
      LOG("tidy-up: mount failed", e);
      el.remove();
      return;
    }
    tidyEl = el;
    armedMods = null;
    openedByKey = false;
    disarmedUntilRelease = true;
    overlay.querySelector(".tts-list").hidden = true;
    overlay.querySelector(".tts-hint").hidden = true;
    const toast = overlay.querySelector(".tts-toast");
    if (toast) hideToast(toast);
    paintCleanup(overlay);
    LOG("entered tidy-up with", tidyQueueIds.length, "tabs (release-to-switch disarmed)");
  }

  /** Follows a tab Chrome gave a new id (a discard), in the list and in tidy-up. */
  function replaceTabIdInPage(oldId, newId) {
    // In place, so the list's click handlers (which read tab.id) follow too.
    for (const tab of tabList) if (tab.id === oldId) tab.id = newId;
    if (currentTabId === oldId) currentTabId = newId;
    tidyQueueIds = tidyQueueIds.map((id) => (id === oldId ? newId : id));
    if (tidy) tidy.replaceId(oldId, newId);
  }

  /**
   * Takes tidy-up down and brings the list back. With `refresh`, asks the worker to
   * redraw the list in place, since tabs were closed or slept meanwhile. That redraw
   * does not re-arm switch-on-release, unlike reopening the switcher would.
   */
  function exitTidy(refresh) {
    if (!tidy) return;
    const view = tidy;
    tidy = null;
    try {
      view.destroy();
    } catch (e) {
      LOG("tidy-up destroy failed", e);
    }
    const node = tidyEl;
    tidyEl = null;
    const overlay = findOverlay();
    // An overlay that is fading out keeps tidy-up on screen until it is gone.
    if (!overlay) {
      LOG("tidy-up closed with the overlay");
      return;
    }
    if (node) node.remove();
    const list = overlay.querySelector(".tts-list");
    const hint = overlay.querySelector(".tts-hint");
    if (list) list.hidden = false;
    if (hint) hint.hidden = false;
    paintCleanup(overlay);
    LOG("left tidy-up", refresh ? "— asking for a redraw" : "");
    if (refresh) tellWorker("refresh-switcher");
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
      // Ahead of the text so a long, ellipsized title cannot push it out of view.
      if (tab.discarded) {
        const asleep = document.createElement("span");
        asleep.className = "tts-asleep";
        asleep.title = ASLEEP_TITLE;
        asleep.textContent = "💤";
        title.appendChild(asleep);
      }
      // Own element so a long title ellipsizes while the badge after it stays in view.
      const titleText = document.createElement("span");
      titleText.className = "tts-title-text";
      titleText.textContent = tab.title;
      title.appendChild(titleText);
      if (tab.dupCount > 1) {
        const dup = document.createElement("span");
        dup.className = "tts-dup";
        dup.title = tab.dupCount + " tabs open on this page";
        dup.textContent = "×" + tab.dupCount;
        title.appendChild(dup);
      }
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

  /**
   * Refresh an already-open overlay in place (after a sort or a sleep) — no rebuild
   * flash. Takes the whole show-switcher message.
   */
  function updateTabs(overlay, message) {
    const keepId = tabList[selectedIndex] && tabList[selectedIndex].id;
    tabList = message.tabs;
    currentTabId = message.activeTabId;
    tabCounts = message.counts || tabCounts;
    applyPayload(message);
    // A refresh (after a sleep, say) is not a key press: arming here would fall back to
    // whatever modifiers happen to be held and re-arm switch-on-release. Nor is anything
    // armed under tidy-up.
    if (!message.refresh && !tidy) {
      if (message.openedByKey) openedByKey = true;
      armFrom(message.armMods);
    }
    const i = tabList.findIndex((t) => t.id === keepId);
    selectedIndex = i >= 0 ? i : 0;
    const list = overlay.querySelector(".tts-list");
    renderList(list);
    paintCounts(overlay);
    paintCleanup(overlay);
    paintHint(overlay);
    scrollSelectedIntoView(list);
    LOG("overlay list refreshed, selected index:", selectedIndex);
  }

  /** A header button whose clicks never leave DOM focus on it. */
  function buildBareHeaderButton(className, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
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

  function buildHeaderButton(className, label, svg, onClick) {
    const btn = buildBareHeaderButton(className, onClick);
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    btn.innerHTML = svg;
    return btn;
  }

  /** Builds the overlay from a show-switcher message and returns it. */
  function buildOverlay(message) {
    const tabs = message.tabs;
    LOG("building overlay with", tabs.length, "tabs");
    removeOverlay();
    tabList = tabs;
    currentTabId = message.activeTabId;
    tabCounts = message.counts || null;
    applyPayload(message);
    selectedIndex = tabs.length > 1 ? 1 : 0;
    armedMods = null;
    openedByKey = !!message.openedByKey;
    armFrom(message.armMods);

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    // Focusable so the commit keyup reaches this document and not an input or iframe
    // that happened to hold focus. Does nothing if the page lacks browser focus.
    overlay.tabIndex = -1;
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

    const memory = document.createElement("span");
    memory.className = "tts-header-memory";
    memory.title = "Free memory on this computer, as Chrome reports it";
    memory.hidden = true;
    subLine.appendChild(memory);

    headerMain.appendChild(subLine);

    header.appendChild(headerMain);

    const actions = document.createElement("div");
    actions.className = "tts-header-actions";

    // Label, count and disabled state are painted by paintCleanup.
    actions.appendChild(
      buildBareHeaderButton("tts-header-btn tts-header-sleep", () => requestCleanup("sleep"))
    );
    // Shown only while there is something to dedupe; painted by paintCleanup.
    const dedupeBtn = buildBareHeaderButton("tts-header-btn tts-header-dedupe", () =>
      requestCleanup("dedupe")
    );
    dedupeBtn.hidden = true;
    actions.appendChild(dedupeBtn);

    // Disabled state and title are painted by paintCleanup.
    const tidyBtn = buildBareHeaderButton("tts-header-btn tts-header-tidy", () =>
      enterTidy(findOverlay())
    );
    tidyBtn.textContent = "Tidy up";
    actions.appendChild(tidyBtn);

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

    // Zero-height, in flow between the list and the legend: the toast hangs above it, so
    // it can never cover the legend however many lines that wraps to, and showing or
    // hiding it never shifts the list.
    const toastAnchor = document.createElement("div");
    toastAnchor.className = "tts-toast-anchor";
    container.appendChild(toastAnchor);

    const hint = document.createElement("div");
    hint.className = "tts-hint";
    container.appendChild(hint);

    overlay.appendChild(container);
    // After the container is attached — the painters look their elements up through `overlay`.
    paintCounts(overlay);
    paintCleanup(overlay);
    paintHint(overlay);
    document.documentElement.appendChild(overlay);

    requestAnimationFrame(() => {
      overlay.classList.add("tts-visible");
      scrollSelectedIntoView(list);
      try {
        overlay.focus({ preventScroll: true });
      } catch (e) {
        LOG("overlay focus failed", e);
      }
    });

    tellWorker("overlay-opened");

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    LOG("overlay shown, selected index:", selectedIndex);
    return overlay;
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
    const overlay = findOverlay();
    if (!overlay) return;

    const k = overlayKeyState;
    // Tidy-up owns the keyboard while it is open. Of the overlay's own bindings only
    // the configured close key still works, and it leaves tidy-up (as Escape does), not
    // the overlay. Nothing arms switch-on-release meanwhile.
    if (tidy) {
      if (tidy.handleKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (matchKey(e, k.close)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        LOG("close key pressed in tidy-up, back to the list");
        tidy.exit();
        return;
      }
      // Nothing typed may reach the page behind (its own shortcuts, a held T
      // repeating). Browser chords pass, except on tidy-up's own letters.
      // Autofill can send a keydown without a key.
      const typed = typeof e.key === "string" && e.key.length === 1;
      const ownLetter = typed && TIDY_LETTERS.indexOf(e.key.toLowerCase()) !== -1;
      if (ownLetter || (typed && !e.ctrlKey && !e.altKey && !e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    const list = overlay.querySelector(".tts-list");
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
    if (k.alsoArrows && isBareKey(e, ["ArrowDown"], true)) {
      goNext();
      return;
    }
    if (k.alsoArrows && isBareKey(e, ["ArrowUp"], true)) {
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
    // Same rule as S: a configured binding on Z was matched above and wins. Swallowed
    // even with nothing to sleep, so it never reaches the page (Gmail's undo, say).
    if (isBareKey(e, ["z", "Z"])) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      requestCleanup("sleep");
      return;
    }
    // Same shape as Z: a configured binding on D wins, and D is swallowed either way.
    if (isBareKey(e, ["d", "D"])) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      requestCleanup("dedupe");
      return;
    }
    // Same shape as Z and D. Refused while a cleanup action is out, but still swallowed.
    // Forgives the armed chord's Shift (Alt+Shift+Q, say): entering tidy-up only
    // disarms, so a held Shift cannot make it do anything the user did not mean.
    if (isBareKey(e, ["t", "T"], true)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      enterTidy(overlay);
      return;
    }
  }

  /**
   * Windows' Alt+Tab commits when you let the modifier go; this does the same. Only
   * ever reached while the overlay is open, and only arms/commits when the option is
   * on, so with it off this is two boolean reads per keyup.
   */
  function handleKeyUp(e) {
    if (!findOverlay()) return;
    // Letting go of anything during tidy-up never switches tabs.
    if (tidy) return;
    if (disarmedUntilRelease && !e.ctrlKey && !e.altKey && !e.metaKey) {
      disarmedUntilRelease = false;
      LOG("all modifiers released after a cleanup action — arming allowed again");
    }
    if (!overlayKeyState.commitOnRelease) return;
    // Logged for every keyup so an empty log distinguishes "we decided not to commit"
    // from "this page is not receiving key events at all".
    LOG("keyup", e.key, "armed:", armedMods, "openedByKey:", openedByKey);

    // Either the chord we identified let go, or — when identifying it failed, which
    // happens whenever Chrome consumed the whole chord — any modifier let go after a
    // keyboard open.
    if (armedModifierReleased(e) || (openedByKey && isCommitModifier(e.key))) {
      e.preventDefault();
      e.stopPropagation();
      const tab = tabList[selectedIndex];
      LOG("modifier released, switching to", tab && tab.id);
      if (tab) switchToTab(tab.id);
      else removeOverlay();
      return;
    }
    // Releasing a non-modifier (the Q of Ctrl+Shift+Q, say) still tells us what is
    // being held, which is another chance to identify the chord.
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
    const overlay = findOverlay();
    if (overlay) {
      // From here on findOverlay() no longer sees it, so a redraw or key arriving during
      // the fade cannot touch it.
      overlay.classList.add(CLOSING_CLASS);
      overlay.classList.remove("tts-visible");
      overlay.addEventListener("transitionend", () => overlay.remove(), {
        once: true,
      });
      setTimeout(() => overlay.remove(), 200);
      LOG("overlay removed");
      tellWorker("overlay-closed");
    }
    // After the overlay is marked closing, so tidy-up stays on screen while it fades.
    exitTidy(false);
    tidyQueueIds = [];
    tabList = [];
    selectedIndex = 0;
    currentTabId = null;
    tabCounts = null;
    sleepCount = 0;
    dedupeCount = 0;
    memoryText = "";
    pendingAction = null;
    disarmedUntilRelease = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    openedByKey = false;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "ping") {
      LOG("ping received");
      sendResponse({ ok: true });
      return;
    }
    if (message.action === "tab-replaced") {
      LOG("tab replaced:", message.oldId, "->", message.newId);
      replaceTabIdInPage(message.oldId, message.newId);
      return;
    }
    if (message.action === "advance-selection") {
      const overlay = findOverlay();
      if (overlay && tidy) {
        // Tidy-up has no list selection to move, and must not arm switch-on-release.
        LOG("advance-selection during tidy-up — ignored");
      } else if (overlay) {
        // The chord that got us here is still held, so this is also our chance to
        // identify it if the overlay went up some other way (a toolbar click, say).
        if (message.openedByKey) openedByKey = true;
        armFrom(message.armMods);
        advanceSelection(overlay, message.delta || 1);
      } else if (window.top === window) {
        // The worker still thought we had an overlay. Put one up rather than swallow
        // the keypress; only the top frame answers so we do not open several.
        LOG("advance-selection with no overlay — opening instead");
        tellWorker("gesture-open-switcher");
      }
      return;
    }
    if (message.action === "show-switcher") {
      LOG("show-switcher received with", message.tabs.length, "tabs");
      const open = findOverlay();
      if (!open && message.refresh) {
        // The user closed the overlay while the worker was busy (Esc during a sleep);
        // a redraw must not bring it back.
        LOG("refresh for an overlay that is no longer open — ignored");
        return;
      }
      let overlay = open;
      if (open) {
        updateTabs(open, message);
      } else {
        overlay = buildOverlay(message);
      }
      // updateTabs only redraws the hidden list under tidy-up; a toast would float over
      // the card instead of the list it reports on.
      if (message.result && !tidy) showToast(overlay, message.result);
    }
  });

  /**
   * The worker skips a redraw when the page asking is no longer the active tab, so a
   * Sleep or Dedupe answered while the user was on another tab leaves "Sleeping…" /
   * "Deduping…" behind. Coming back to the page asks for that redraw.
   */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !pendingAction || !findOverlay()) return;
    LOG("page visible again with", pendingAction, "still pending — asking for a redraw");
    tellWorker("refresh-switcher");
  });
})();
