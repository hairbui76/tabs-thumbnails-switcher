if (window.__ttsKeyGestureBound) {
  // Already installed (e.g. manifest + programmatic inject)
} else {
  window.__ttsKeyGestureBound = true;

  var ttsCreate = typeof self.__ttsCreateTtsLog === "function" ? self.__ttsCreateTtsLog : function () { return function () { }; };
  const LOG = ttsCreate("key-gesture");

  /** @type {ReturnType<typeof setTimeout> | null} */
  let holdTimer = null;
  let longPressFired = false;
  let pending = false;

  // How long to hold (ms) before the tab switcher overlay opens
  const HOLD_MS = 300;
  // In-page long-press: same chord as command "open-tab-switcher" (Ctrl+Shift+physical Q).
  const G = { ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: "KeyQ" };

  function matchGesture(e) {
    return (
      e.ctrlKey === G.ctrlKey &&
      e.shiftKey === G.shiftKey &&
      e.altKey === G.altKey &&
      e.metaKey === G.metaKey &&
      e.code === G.code
    );
  }

  function onKeyDown(e) {
    if (!matchGesture(e) || e.repeat) return;
    e.preventDefault();
    e.stopPropagation();
    if (holdTimer) clearTimeout(holdTimer);
    longPressFired = false;
    pending = true;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      longPressFired = true;
      LOG("long-press: open switcher");
      try {
        chrome.runtime.sendMessage({ action: "gesture-open-switcher" });
      } catch (err) {
        LOG("gesture-open-switcher error:", err);
      }
    }, HOLD_MS);
  }

  function onKeyUp(e) {
    if (e.code !== G.code) return;
    if (!pending) return;
    e.preventDefault();
    e.stopPropagation();
    pending = false;
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (!longPressFired) {
      LOG("released before hold threshold — use extension shortcut for quick previous tab, or keep holding to open menu");
    } else {
      LOG("key up after long-press (menu already open)");
    }
    longPressFired = false;
  }

  function onBlur() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur, true);

  LOG("ready: hold", HOLD_MS, "ms to open menu. Same chord as command open-tab-switcher. Quick switch = quick-previous-mru in chrome://extensions/shortcuts. Edit G in this file to change the in-page long-press only.");
}
