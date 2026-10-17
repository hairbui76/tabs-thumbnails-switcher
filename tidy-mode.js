/**
 * Tidy-up mode for the switcher overlay.
 * Exposes on self/ globalThis: TTS_tidy = { tidyInit, tidyCurrent, tidyApply, tidyLastUndoBatch }
 * (the card UI, TTS_tidy.mount, is added to the same object later).
 *
 * Loaded as a content script before content.js and may be injected more than
 * once into a page, so it only (re)assigns functions on a shared object and does
 * nothing at load time: no DOM, no chrome.*.
 */
(function (g) {
  "use strict";

  var T = g.TTS_tidy || (g.TTS_tidy = {});

  // ---- State machine (pure) ------------------------------------------------
  //
  // TidyState = { queue: number[], pos: number, history: Entry[], stats: { closed, kept, slept } }
  // Entry     = { type: "keep" | "closed" | "slept", pos: number, batchId?: string }
  //
  // tidyApply never mutates its input; it returns a new state (or the same one
  // when the action is a no-op).

  var STAT = Object.create(null);
  STAT.keep = "kept";
  STAT.closed = "closed";
  STAT.slept = "slept";

  T.tidyInit = function (queue) {
    return {
      queue: (queue || []).slice(),
      pos: 0,
      history: [],
      stats: { closed: 0, kept: 0, slept: 0 },
    };
  };

  T.tidyCurrent = function (s) {
    return s.pos < s.queue.length ? s.queue[s.pos] : null;
  };

  T.tidyApply = function (s, action) {
    var type = action && action.type;

    if (type === "undo") {
      if (!s.history.length) return s;
      var top = s.history[s.history.length - 1];
      var stats = copyStats(s.stats);
      stats[STAT[top.type]] -= 1;
      // Ids in the queue follow the live tab, because the old ids no longer
      // exist: a slept tab keeps the id Chrome gave it on discard, and a tab
      // reopened by undoing a close takes the newId sessions.restore gave it.
      return {
        queue: withId(s.queue, top.pos, action.newId),
        pos: top.pos,
        history: s.history.slice(0, -1),
        stats: stats,
      };
    }

    if (type === "replace") {
      // Chrome replaced a tab on its own (e.g. a discard) while tidy-up is open.
      if (action.newId == null || s.queue.indexOf(action.oldId) === -1) return s;
      return {
        queue: s.queue.map(function (id) {
          return id === action.oldId ? action.newId : id;
        }),
        pos: s.pos,
        history: s.history,
        stats: s.stats,
      };
    }

    if (T.tidyCurrent(s) === null) return s;

    if (type === "skip") {
      // The tab vanished: move on without a stat and without a history entry,
      // so U steps back to the last real decision, not onto a missing tab.
      return { queue: s.queue, pos: s.pos + 1, history: s.history, stats: s.stats };
    }

    if (typeof type !== "string" || !STAT[type]) return s;

    var entry = { type: type, pos: s.pos };
    if (type === "closed" && action.batchId != null) entry.batchId = action.batchId;
    var next = copyStats(s.stats);
    next[STAT[type]] += 1;
    return {
      queue: type === "slept" ? withId(s.queue, s.pos, action.newId) : s.queue,
      pos: s.pos + 1,
      history: s.history.concat([entry]),
      stats: next,
    };
  };

  T.tidyLastUndoBatch = function (s) {
    var top = s.history[s.history.length - 1];
    return top && top.type === "closed" && top.batchId != null ? top.batchId : null;
  };

  // Returns queue with queue[pos] = id, copying only when an id is given.
  function withId(queue, pos, id) {
    if (id == null) return queue;
    var q = queue.slice();
    q[pos] = id;
    return q;
  }

  function copyStats(st) {
    return { closed: st.closed, kept: st.kept, slept: st.slept };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = T;
})(typeof self !== "undefined" ? self : this);
