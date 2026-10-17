/**
 * Pure tab-cleanup rules (Sleep, Dedupe, Tidy-up) and their user-facing copy.
 * No chrome.* calls: loaded by the service worker through importScripts and by
 * Node tests through module.exports.
 * Exposes on self/ globalThis: normalizeUrl, sleepCandidates, duplicatePlan,
 * tidyQueue, formatGB, sleepToastText, dedupeToastText, memoryLineText,
 * matchClosedSessions, replaceTabId
 *
 * "Tab" below means the subset { id, url, pinned, audible, discarded,
 * autoDiscardable } of chrome.tabs.Tab.
 *
 * Functions call each other through their local names, never through the
 * globals, so a later global of the same name cannot change their behaviour.
 */
(function (g) {
  "use strict";

  var GB = 1024 * 1024 * 1024;

  /** URL without its #fragment; "" for empty input; unparsable input unchanged. */
  function normalizeUrl(url) {
    if (typeof url !== "string" || url === "") return "";
    try {
      var u = new URL(url);
      u.hash = "";
      return u.href;
    } catch (e) {
      return url;
    }
  }

  /**
   * Normalized URLs that never count as duplicates of each other: empty (still
   * loading) and about:blank (popups sit there while loading, and script-filled
   * popups would lose their content if closed).
   */
  function isUngroupable(key) {
    return key === "" || key === "about:blank";
  }

  /** Tabs that may be discarded, as ids in input order. */
  function sleepCandidates(tabs, activeTabId) {
    var out = [];
    (tabs || []).forEach(function (t) {
      if (t.id === activeTabId) return;
      if (t.pinned || t.audible || t.discarded) return;
      if (t.autoDiscardable === false) return;
      out.push(t.id);
    });
    return out;
  }

  /**
   * Groups tabs by normalized URL. In each group of 2+ the copy to keep is the
   * active tab, else a pinned tab, else the most recently used one (tabs absent
   * from mruList rank last). The others close, except active and pinned tabs.
   * Empty and about:blank URLs are never grouped.
   * toClose is in input order; dupCount[id] = group size for groups of 2+.
   */
  function duplicatePlan(tabs, mruList, activeTabId) {
    var mruIndex = new Map();
    (mruList || []).forEach(function (id, i) {
      if (!mruIndex.has(id)) mruIndex.set(id, i);
    });
    function mruOf(t) {
      return mruIndex.has(t.id) ? mruIndex.get(t.id) : Infinity;
    }

    var groups = new Map();
    (tabs || []).forEach(function (t, i) {
      var key = normalizeUrl(t.url);
      if (isUngroupable(key)) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ tab: t, pos: i });
    });

    var dupCount = {};
    var closing = [];
    groups.forEach(function (group) {
      if (group.length < 2) return;
      group.forEach(function (e) {
        dupCount[e.tab.id] = group.length;
      });
      var ranked = group.slice().sort(function (a, b) {
        var aActive = a.tab.id === activeTabId ? 1 : 0;
        var bActive = b.tab.id === activeTabId ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        var aPinned = a.tab.pinned ? 1 : 0;
        var bPinned = b.tab.pinned ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;
        var am = mruOf(a.tab);
        var bm = mruOf(b.tab);
        if (am !== bm) return am < bm ? -1 : 1;
        return a.pos - b.pos;
      });
      ranked.slice(1).forEach(function (e) {
        if (e.tab.id === activeTabId || e.tab.pinned) return;
        closing.push(e);
      });
    });

    closing.sort(function (a, b) {
      return a.pos - b.pos;
    });
    return {
      toClose: closing.map(function (e) {
        return e.tab.id;
      }),
      dupCount: dupCount,
    };
  }

  /**
   * Tidy-up review order: least recently visited first (missing stamp = 0),
   * ties in input order. Excludes the active tab and pinned tabs.
   */
  function tidyQueue(tabs, lastAccessed, activeTabId) {
    var stamps = lastAccessed || {};
    function stampOf(id) {
      var s = stamps[id];
      return typeof s === "number" && isFinite(s) ? s : 0;
    }
    return (tabs || [])
      .filter(function (t) {
        return t.id !== activeTabId && !t.pinned;
      })
      .map(function (t, i) {
        return { id: t.id, stamp: stampOf(t.id), pos: i };
      })
      .sort(function (a, b) {
        if (a.stamp !== b.stamp) return a.stamp - b.stamp;
        return a.pos - b.pos;
      })
      .map(function (e) {
        return e.id;
      });
  }

  /** Bytes as a whole number of tenths of a GB (the precision formatGB shows). */
  function tenthsOfGB(bytes) {
    return Math.round((bytes / GB) * 10);
  }

  /** "1.8 GB" below 10 GB, "16 GB" at or above (after rounding). */
  function formatGB(bytes) {
    var tenths = tenthsOfGB(bytes);
    if (Math.abs(tenths) >= 100) return Math.round(bytes / GB) + " GB";
    return (tenths / 10).toFixed(1) + " GB";
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  /**
   * "Put 12 tabs to sleep · freed ~1.8 GB". The figure is shown only when it is
   * a positive number that does not round down to 0.0 GB.
   * Failures append " · 2 could not sleep".
   */
  function sleepToastText(r) {
    var text = "Put " + plural(r.slept, "tab", "tabs") + " to sleep";
    var freed = r.freedBytes;
    if (typeof freed === "number" && isFinite(freed) && tenthsOfGB(freed) > 0) {
      text += " · freed ~" + formatGB(freed);
    }
    if (r.failed > 0) text += " · " + r.failed + " could not sleep";
    return text;
  }

  /** "Closed 7 duplicate tabs — the newest copy stays open". */
  function dedupeToastText(closed) {
    return "Closed " + plural(closed, "duplicate tab", "duplicate tabs") + " — the newest copy stays open";
  }

  /** "RAM: 2.9 GB free of 16 GB"; "" when memory info is missing or invalid. */
  function memoryLineText(mem) {
    if (!mem) return "";
    var available = mem.available;
    var capacity = mem.capacity;
    if (typeof capacity !== "number" || !isFinite(capacity) || capacity <= 0) return "";
    if (typeof available !== "number" || !isFinite(available) || available < 0) return "";
    return "RAM: " + formatGB(available) + " free of " + formatGB(capacity);
  }

  /**
   * For each closed-tab record, the sessionId of a recently closed tab with the
   * same normalized URL, or null. Each session is used at most once, so two
   * closed copies of one URL restore two different sessions. Window entries
   * (no .tab) and sessions without a sessionId are skipped; empty and
   * about:blank records never match.
   */
  function matchClosedSessions(records, recentlyClosed) {
    var used = [];
    var sessions = recentlyClosed || [];
    return (records || []).map(function (rec) {
      var key = normalizeUrl(rec && rec.url);
      if (isUngroupable(key)) return null;
      for (var i = 0; i < sessions.length; i++) {
        var t = sessions[i] && sessions[i].tab;
        if (used[i] || !t || !t.sessionId) continue;
        if (normalizeUrl(t.url) !== key) continue;
        used[i] = true;
        return t.sessionId;
      }
      return null;
    });
  }

  /** Copy of list with removedId replaced by addedId (chrome.tabs.onReplaced). */
  function replaceTabId(list, removedId, addedId) {
    return (list || []).map(function (id) {
      return id === removedId ? addedId : id;
    });
  }

  var api = {
    normalizeUrl: normalizeUrl,
    sleepCandidates: sleepCandidates,
    duplicatePlan: duplicatePlan,
    tidyQueue: tidyQueue,
    formatGB: formatGB,
    sleepToastText: sleepToastText,
    dedupeToastText: dedupeToastText,
    memoryLineText: memoryLineText,
    matchClosedSessions: matchClosedSessions,
    replaceTabId: replaceTabId,
  };
  for (var k in api) g[k] = api[k];
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
