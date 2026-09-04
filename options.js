(function () {
  /**
   * ISO date (YYYY-MM-DD) shown on the About section. This value is a placeholder: the
   * release workflow rewrites this exact line when it packages the zip, so what users
   * install always carries the real release date. release-please cannot do it — its
   * generic updater only understands version annotations, not dates — and maintaining
   * it by hand drifted four months and three releases.
   */
  var TTS_RELEASE_DATE_ISO = "2026-09-03";

  var g = self;
  var sk = g.TTS_STORAGE_KEY_OVERLAY_KEYS;
  var merge = g.TTS_mergeOverlayKeys;
  var format = g.TTS_formatKeySpec;

  function formatUpdated(iso) {
    if (!iso || typeof iso !== "string") return "—";
    var t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    try {
      return new Date(t).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch (e) {
      return iso;
    }
  }

  function fillAbout() {
    var m = chrome.runtime.getManifest();
    var name = m.name || "";
    var pageTitle = document.getElementById("pageTitle");
    if (pageTitle && m.version) {
      pageTitle.textContent = "Options — " + name + " v" + m.version;
    }
    document.title = (name ? name + " — " : "") + "Options" + (m.version ? " v" + m.version : "");
    var el = function (id) {
      return document.getElementById(id);
    };
    if (el("aboutName")) el("aboutName").textContent = name;
    if (el("aboutVersion")) el("aboutVersion").textContent = m.version || "—";
    if (el("aboutUpdated")) el("aboutUpdated").textContent = formatUpdated(TTS_RELEASE_DATE_ISO);
    if (el("aboutDesc")) el("aboutDesc").textContent = m.description || "—";
  }

  function fillCtrlTabSnippet() {
    var pre = document.getElementById("ctrlTabSnippet");
    if (!pre) return;
    var id = chrome.runtime.id;
    pre.textContent =
      "await chrome.developerPrivate.updateExtensionCommand({\n" +
      "  extensionId: \"" +
      id +
      "\",\n" +
      "  commandName: \"quick-previous-mru\",\n" +
      "  keybinding: \"Ctrl+Tab\"\n" +
      "});";
  }

  var cb = document.getElementById("ttsDebug");
  var alsoAr = document.getElementById("alsoArrows");
  var onRel = document.getElementById("commitOnRelease");
  var capMsg = document.getElementById("capMsg");
  var vNext = document.getElementById("vNext");
  var vPrev = document.getElementById("vPrev");
  var vSw = document.getElementById("vSw");
  var vCl = document.getElementById("vCl");
  var bNext = document.getElementById("bNext");
  var bPrev = document.getElementById("bPrev");
  var bSw = document.getElementById("bSw");
  var bCl = document.getElementById("bCl");

  var state = merge(null);
  var capHandler = null;

  function getQuery() {
    var q = { ttsDebug: false };
    q[sk] = null;
    return q;
  }

  function readAll() {
    chrome.storage.local.get(getQuery(), function (s) {
      state = merge(s[sk]);
      if (s.ttsDebug !== undefined) cb.checked = !!s.ttsDebug;
      render();
    });
  }

  function render() {
    vNext.textContent = format(state.next);
    vPrev.textContent = format(state.prev);
    vSw.textContent = format(state.switch);
    vCl.textContent = format(state.close);
    alsoAr.checked = state.alsoArrows !== false;
    onRel.checked = state.commitOnRelease === true;
  }

  function saveOverlayKeys() {
    state.alsoArrows = alsoAr.checked;
    state.commitOnRelease = onRel.checked;
    var p = {};
    p[sk] = {
      next: state.next,
      prev: state.prev,
      switch: state.switch,
      close: state.close,
      alsoArrows: state.alsoArrows,
      commitOnRelease: state.commitOnRelease,
    };
    chrome.storage.local.set(p, function () {
      state = merge(p[sk]);
    });
  }

  function stopCapture() {
    if (capHandler) {
      window.removeEventListener("keydown", capHandler, true);
      capHandler = null;
    }
    capMsg.textContent = "";
  }

  function startCapture(id) {
    if (capHandler) window.removeEventListener("keydown", capHandler, true);
    capMsg.textContent = "Press a key combination (Escape to cancel)…";
    capHandler = function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        stopCapture();
        return;
      }
      if (
        e.key === "Meta" ||
        e.key === "Control" ||
        e.key === "Shift" ||
        e.key === "Alt" ||
        e.key === "OS"
      ) {
        return;
      }
      var spec = {
        k: e.key,
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        meta: e.metaKey,
      };
      if (id === "next") state.next = spec;
      else if (id === "prev") state.prev = spec;
      else if (id === "switch") state.switch = spec;
      else if (id === "close") state.close = spec;
      saveOverlayKeys();
      stopCapture();
      render();
    };
    window.addEventListener("keydown", capHandler, true);
  }

  bNext.addEventListener("click", function () {
    startCapture("next");
  });
  bPrev.addEventListener("click", function () {
    startCapture("prev");
  });
  bSw.addEventListener("click", function () {
    startCapture("switch");
  });
  bCl.addEventListener("click", function () {
    startCapture("close");
  });
  alsoAr.addEventListener("change", function () {
    saveOverlayKeys();
  });
  onRel.addEventListener("change", function () {
    saveOverlayKeys();
  });

  cb.addEventListener("change", function () {
    chrome.storage.local.set({ ttsDebug: cb.checked });
  });

  readAll();
  fillAbout();
  fillCtrlTabSnippet();

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes[sk] || changes.ttsDebug) readAll();
  });
})();
