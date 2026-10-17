/**
 * Tidy-up mode for the switcher overlay.
 * Exposes on self/ globalThis: TTS_tidy = { tidyInit, tidyCurrent, tidyApply,
 * tidyLastUndoBatch, tidySummaryText, ASLEEP_TITLE, mount }.
 *
 * Loaded as a content script before content.js and may be injected more than
 * once into a page, so it only (re)assigns functions on a shared object and does
 * nothing at load time: no DOM, no chrome.*. The DOM is touched only by mount().
 */
(function (g) {
  "use strict";

  var T = g.TTS_tidy || (g.TTS_tidy = {});

  // ---- State machine (pure) ------------------------------------------------
  //
  // TidyState = { queue: number[], pos: number, history: Entry[], stats: { closed, kept, slept } }
  // Entry     = { type: "keep" | "closed" | "slept", pos: number, batchId?: string }
  // Actions   = keep | closed {batchId} | slept {newId?} | skip | undo {newId?}
  //             | replace {oldId, newId} | forget
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

    if (type === "forget") {
      // The last step can no longer be undone (its closed tab could not be reopened):
      // drop it from history and its tab from the queue, so no later undo can land on
      // the dead tab. The closed stat stays, since the tab really is closed. Every
      // history entry sits before pos, so pos moves back by the one slot removed.
      if (!s.history.length) return s;
      var dead = s.history[s.history.length - 1].pos;
      return {
        queue: withoutSlot(s.queue, dead),
        pos: s.pos - 1,
        history: s.history.slice(0, -1),
        stats: s.stats,
      };
    }

    if (T.tidyCurrent(s) === null) return s;

    if (type === "skip") {
      // The tab vanished: drop it from the queue (the next tab moves up into pos)
      // without a stat or a history entry, so U steps back to the last real decision
      // and can never land on a missing tab.
      return { queue: withoutSlot(s.queue, s.pos), pos: s.pos, history: s.history, stats: s.stats };
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

  /** The end-of-queue line: "Closed 12 · kept 20 · slept 5". */
  T.tidySummaryText = function (stats) {
    return "Closed " + stats.closed + " · kept " + stats.kept + " · slept " + stats.slept;
  };

  // ---- Card UI ----------------------------------------------------------------

  /** Tooltip of the 💤 marker, shared with the list in content.js. */
  T.ASLEEP_TITLE = "Asleep — reloads when you open it";

  var ERROR_TEXT = "Couldn't do that — try again or press K to skip";
  var REOPEN_FAILED_TEXT = "Couldn't reopen that tab — it stays closed";
  var REOPENED_UNKNOWN_TEXT = "Reopened, but couldn't find the tab — press K to skip";
  var LEGEND = [
    ["X", "close"],
    ["K", "keep"],
    ["Z", "sleep"],
    ["U", "undo"],
    ["Enter", "open"],
    ["Esc", "back"],
  ];

  /**
   * Shows tidy-up inside `opts.container` (emptied first) and returns
   * { handleKey(e): boolean, exit(), replaceId(oldId, newId), destroy() }.
   *
   * - handleKey returns true when it consumed the event; the caller then stops it.
   * - exit() leaves the way Escape does: once any request out has been answered, it
   *   calls onExit.
   * - replaceId follows a tab Chrome gave a new id (tabs.onReplaced).
   * - destroy() may be called more than once; the caller removes the container.
   *
   * opts: container (element), tabs (the overlay's tab objects, looked up by id for the
   * card), queue (tab ids, least recently visited first), send(msg) -> Promise of the
   * worker's answer, onExit(), onSwitch(tabId), domainOf(url) and visitedOf(ms) for the
   * card's second line.
   *
   * One request at a time: while one is out, further action keys are swallowed so a fast
   * double press cannot act twice, and leaving waits for the answer, so the list redraw
   * that follows sees the finished action. Answers arriving after destroy() are dropped.
   */
  T.mount = function (opts) {
    var container = opts.container;
    var doc = container.ownerDocument;
    var LOG = typeof g.__ttsCreateTtsLog === "function" ? g.__ttsCreateTtsLog("tidy") : function () {};

    // Tab data by id. Re-keyed when a tab's id changes (a discard, a reopen by undo, a
    // replacement) so the card keeps showing the right tab.
    var byId = new Map();
    opts.tabs.forEach(function (t) {
      byId.set(t.id, t);
    });

    var state = T.tidyInit(opts.queue);
    // Skips shrink the queue, so the summary title looks at where it started.
    var startedEmpty = state.queue.length === 0;
    var busy = false;
    var exitWhenIdle = false;
    var destroyed = false;
    var errorText = "";

    function el(tag, cls, text) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    container.textContent = "";
    // Counter, card and error scroll together; the legend stays put below them, like
    // the list's own legend.
    var scroll = el("div", "tts-tidy-scroll");
    var counter = el("div", "tts-tidy-counter");
    var body = el("div", "tts-tidy-body");
    var error = el("div", "tts-tidy-error");
    error.setAttribute("role", "alert");
    scroll.appendChild(counter);
    scroll.appendChild(body);
    scroll.appendChild(error);
    var legend = el("div", "tts-tidy-legend");
    LEGEND.forEach(function (pair, i) {
      if (i) legend.appendChild(doc.createTextNode(" · "));
      legend.appendChild(el("span", "tts-key", pair[0]));
      legend.appendChild(doc.createTextNode(" " + pair[1]));
    });
    container.appendChild(scroll);
    container.appendChild(legend);
    LOG("tidy-up mounted with", state.queue.length, "tabs:", state.queue);
    render();

    function render() {
      if (destroyed) return;
      var cur = T.tidyCurrent(state);
      counter.textContent = state.queue.length - state.pos + " left";
      body.textContent = "";
      body.appendChild(cur === null ? buildSummary() : buildCard(cur));
      body.classList.toggle("tts-tidy-busy", busy);
      error.textContent = errorText;
      error.hidden = !errorText;
    }

    function buildCard(id) {
      var tab = byId.get(id);
      var card = el("div", "tts-tidy-card");

      if (tab && tab.thumbnail) {
        var img = el("img", "tts-tidy-thumbnail");
        img.src = tab.thumbnail;
        img.alt = "Tab preview";
        card.appendChild(img);
      } else {
        card.appendChild(el("div", "tts-tidy-thumbnail-placeholder", "No preview"));
      }

      var title = el("div", "tts-tidy-title");
      if (tab && tab.discarded) {
        var asleep = el("span", "tts-asleep", "💤");
        asleep.title = T.ASLEEP_TITLE;
        title.appendChild(asleep);
      }
      var text = tab ? tab.title || "Untitled" : "This tab is no longer in the list";
      var titleText = el("span", "tts-tidy-title-text", text);
      titleText.title = text;
      title.appendChild(titleText);
      if (tab && tab.dupCount > 1) {
        var dup = el("span", "tts-dup", "×" + tab.dupCount);
        dup.title = tab.dupCount + " tabs open on this page";
        title.appendChild(dup);
      }
      card.appendChild(title);

      var meta = el("div", "tts-tidy-meta", tab ? opts.domainOf(tab.url || "") : "");
      var visited = tab ? opts.visitedOf(tab.lastAccessed) : "";
      if (visited) meta.appendChild(el("span", "tts-visited", "last visit " + visited));
      card.appendChild(meta);
      return card;
    }

    function buildSummary() {
      var wrap = el("div", "tts-tidy-summary");
      wrap.appendChild(
        el("div", "tts-tidy-summary-title", startedEmpty ? "Nothing to tidy up" : "All done")
      );
      wrap.appendChild(el("div", "tts-tidy-summary-text", T.tidySummaryText(state.stats)));
      var back = el("button", "tts-tidy-back", "Back to list");
      back.type = "button";
      back.addEventListener("click", function (e) {
        e.stopPropagation();
        e.preventDefault();
        back.blur();
        exit();
      });
      wrap.appendChild(back);
      return wrap;
    }

    /** Applies an action and redraws once, with `message` (if any) on the error line. */
    function dispatch(action, message) {
      state = T.tidyApply(state, action);
      errorText = message || "";
      render();
    }

    function fail(res) {
      if (res && res.error) LOG("tidy action refused:", res.error);
      errorText = ERROR_TEXT;
      render();
    }

    /** Copies a tab's data to its new id, with `patch` applied. */
    function rekey(oldId, newId, patch) {
      var t = byId.get(oldId);
      if (t) byId.set(newId, Object.assign({}, t, { id: newId }, patch));
    }

    /**
     * Sends one request; onResult gets the answer and must redraw (dispatch or fail).
     * A rejected send, or a throw while handling the answer, shows the error instead.
     */
    function request(msg, onResult) {
      busy = true;
      errorText = "";
      render();
      opts
        .send(msg)
        .then(function (res) {
          if (destroyed) return;
          busy = false;
          onResult(res);
        })
        .catch(function (err) {
          if (destroyed) return;
          busy = false;
          LOG(msg.action, "failed:", err && err.message);
          fail();
        })
        .then(function () {
          if (destroyed || !exitWhenIdle) return;
          exitWhenIdle = false;
          exit();
        });
    }

    function closeCurrent() {
      var id = T.tidyCurrent(state);
      if (id === null) return;
      request({ action: "tidy-close", tabId: id }, function (res) {
        if (res && res.ok) dispatch({ type: "closed", batchId: res.batchId });
        else if (res && res.gone) dispatch({ type: "skip" });
        else fail(res);
      });
    }

    function sleepCurrent() {
      var id = T.tidyCurrent(state);
      if (id === null) return;
      request({ action: "tidy-sleep", tabId: id }, function (res) {
        if (res && res.ok) {
          var newId = res.newId != null ? res.newId : id;
          rekey(id, newId, { discarded: true });
          dispatch({ type: "slept", newId: newId });
        } else if (res && res.gone) {
          dispatch({ type: "skip" });
        } else {
          fail(res);
        }
      });
    }

    function keepCurrent() {
      if (T.tidyCurrent(state) !== null) dispatch({ type: "keep" });
    }

    function undoLast() {
      if (!state.history.length) return;
      var top = state.history[state.history.length - 1];
      if (top.type !== "closed") {
        dispatch({ type: "undo" });
        return;
      }
      var oldId = state.queue[top.pos];
      var batchId = T.tidyLastUndoBatch(state);
      if (batchId === null) {
        // Closed, but the worker could not store the undo record.
        dispatch({ type: "forget" }, REOPEN_FAILED_TEXT);
        return;
      }
      request({ action: "undo-close", batchId: batchId }, function (res) {
        if (!res || typeof res.restored !== "number" || res.error) {
          fail(res);
        } else if (res.restored < 1) {
          // The batch is gone (already used, or pushed out by newer ones): this step
          // cannot be undone, so drop it and let the next U reach the one before.
          dispatch({ type: "forget" }, REOPEN_FAILED_TEXT);
        } else if (!Array.isArray(res.tabIds) || res.tabIds[0] == null) {
          // Back, but Chrome did not say as which tab: the card's id is dead.
          dispatch({ type: "undo" }, REOPENED_UNKNOWN_TEXT);
        } else {
          rekey(oldId, res.tabIds[0], { discarded: false });
          dispatch({ type: "undo", newId: res.tabIds[0] });
        }
      });
    }

    function openCurrent() {
      var id = T.tidyCurrent(state);
      // On the summary Enter does what its only button does.
      if (id === null) exit();
      else opts.onSwitch(id);
    }

    function exit() {
      if (destroyed) return;
      if (busy) {
        exitWhenIdle = true;
        return;
      }
      LOG("leaving tidy-up:", T.tidySummaryText(state.stats));
      opts.onExit();
    }

    function replaceId(oldId, newId) {
      if (destroyed) return;
      // The Z answer may already have stored the slept tab under newId (marked asleep);
      // a later replacement notice must not overwrite it with the older data.
      if (!byId.has(newId)) rekey(oldId, newId);
      var next = T.tidyApply(state, { type: "replace", oldId: oldId, newId: newId });
      if (next === state) return;
      LOG("tab", oldId, "is now", newId);
      state = next;
      render();
    }

    var KEYS = {
      x: closeCurrent,
      k: keepCurrent,
      z: sleepCurrent,
      u: undoLast,
      Enter: openCurrent,
      Escape: exit,
    };

    function handleKey(e) {
      // Autofill can send a keydown without a key.
      if (destroyed || typeof e.key !== "string") return false;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
      var key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (!Object.prototype.hasOwnProperty.call(KEYS, key)) return false;
      if (e.repeat) return true;
      if (busy && key !== "Escape") {
        LOG("request in flight — ignored", key);
        return true;
      }
      KEYS[key]();
      return true;
    }

    // Stops the view: keys, clicks and late answers are ignored from here on. The
    // container is left as it is for the caller to remove, so an overlay fading out
    // does not visibly collapse.
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      LOG("tidy-up closed");
    }

    return { handleKey: handleKey, exit: exit, replaceId: replaceId, destroy: destroy };
  };

  function withoutSlot(queue, pos) {
    return queue.slice(0, pos).concat(queue.slice(pos + 1));
  }

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
