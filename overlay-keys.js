/**
 * Shared overlay keyboard defaults, matching, and labels.
 * Exposes on self/ globalThis: TTS_OVERLAY_KEY_DEFAULTS, TTS_mergeOverlayKeys, TTS_keyMatches, TTS_formatKeySpec, TTS_STORAGE_KEY_OVERLAY_KEYS
 */
(function (g) {
  g.TTS_STORAGE_KEY_OVERLAY_KEYS = "overlayKeys";
  g.TTS_OVERLAY_KEY_DEFAULTS = {
    next: { k: "Tab", shift: false, ctrl: false, alt: false, meta: false },
    prev: { k: "Tab", shift: true, ctrl: false, alt: false, meta: false },
    switch: { k: "Enter", shift: false, ctrl: false, alt: false, meta: false },
    close: { k: "Escape", shift: false, ctrl: false, alt: false, meta: false },
    alsoArrows: true,
  };

  g.TTS_mergeOverlayKeys = function (stored) {
    var b = g.TTS_OVERLAY_KEY_DEFAULTS;
    if (!stored || typeof stored !== "object") {
      return JSON.parse(JSON.stringify(b));
    }
    return {
      next: g.TTS_mergeKeySpec(b.next, stored.next),
      prev: g.TTS_mergeKeySpec(b.prev, stored.prev),
      switch: g.TTS_mergeKeySpec(b.switch, stored.switch),
      close: g.TTS_mergeKeySpec(b.close, stored.close),
      alsoArrows: stored.alsoArrows !== false,
    };
  };

  g.TTS_mergeKeySpec = function (def, o) {
    if (!o || typeof o !== "object") return JSON.parse(JSON.stringify(def));
    return {
      k: typeof o.k === "string" ? o.k : def.k,
      shift: !!o.shift,
      ctrl: !!o.ctrl,
      alt: !!o.alt,
      meta: !!o.meta,
    };
  };

  g.TTS_keyMatches = function (e, spec) {
    if (e.key !== spec.k) return false;
    if (e.shiftKey !== !!spec.shift) return false;
    if (e.ctrlKey !== !!spec.ctrl) return false;
    if (e.altKey !== !!spec.alt) return false;
    if (e.metaKey !== !!spec.meta) return false;
    return true;
  };

  g.TTS_formatKeySpec = function (spec) {
    if (!spec || !spec.k) return "";
    var p = [];
    if (spec.ctrl) p.push("Ctrl");
    if (spec.alt) p.push("Alt");
    if (spec.shift) p.push("Shift");
    if (spec.meta) p.push("Meta");
    p.push(tidyKeyName(spec.k));
    return p.join("+");
  };

  function tidyKeyName(k) {
    if (k === " ") return "Space";
    if (k.length === 1) return k.toUpperCase();
    return k;
  }

  g.TTS_hintHtml = function (keys) {
    var a = g.TTS_formatKeySpec;
    return (
      '<span class="tts-key">' + esc(a(keys.next) + " / " + a(keys.prev)) + "</span> navigate &nbsp; " +
      '<span class="tts-key">' + esc(a(keys.switch)) + "</span> switch &nbsp; " +
      '<span class="tts-key">' + esc(a(keys.close)) + "</span> close" +
      (keys.alsoArrows
        ? ' <span class="tts-hint-extra" style="opacity:0.65">· Arrows: also navigate</span>'
        : "")
    );
  };

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})(typeof self !== "undefined" ? self : this);
