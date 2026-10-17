"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../tidy-mode.js");

function deepFreeze(o) {
  if (o && typeof o === "object") {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

test("tidyInit([]) has no current tab (opens straight onto the summary)", () => {
  const s = T.tidyInit([]);
  assert.equal(T.tidyCurrent(s), null);
  assert.deepEqual(s, { queue: [], pos: 0, history: [], stats: { closed: 0, kept: 0, slept: 0 } });
});

test("keep, closed, slept advance to pos 3 and count each stat once", () => {
  let s = T.tidyInit([1, 2, 3]);
  assert.equal(T.tidyCurrent(s), 1);
  s = T.tidyApply(s, { type: "keep" });
  s = T.tidyApply(s, { type: "closed", batchId: "b1" });
  s = T.tidyApply(s, { type: "slept" });
  assert.equal(s.pos, 3);
  assert.deepEqual(s.stats, { closed: 1, kept: 1, slept: 1 });
  assert.equal(T.tidyCurrent(s), null);
});

test("slept with newId rewrites queue[pos] before advancing", () => {
  let s = T.tidyInit([5, 6]);
  s = T.tidyApply(s, { type: "slept", newId: 99 });
  assert.equal(s.queue[0], 99);
  assert.equal(T.tidyCurrent(s), 6);
});

test("slept without newId keeps the queue identity", () => {
  const s = T.tidyInit([5, 6]);
  const next = T.tidyApply(s, { type: "slept" });
  assert.equal(next.queue, s.queue);
});

test("closed exposes its batch for undo; undo restores pos, stat and current", () => {
  let s = T.tidyInit([10, 11]);
  s = T.tidyApply(s, { type: "closed", batchId: "b1" });
  assert.equal(T.tidyLastUndoBatch(s), "b1");
  s = T.tidyApply(s, { type: "undo" });
  assert.equal(s.pos, 0);
  assert.equal(s.stats.closed, 0);
  assert.equal(T.tidyCurrent(s), 10);
  assert.equal(T.tidyLastUndoBatch(s), null);
});

test("undo with newId puts the reopened tab's id back in the queue", () => {
  const s = T.tidyApply(T.tidyInit([10, 11]), { type: "closed", batchId: "b1" });
  deepFreeze(s);
  const u = T.tidyApply(s, { type: "undo", newId: 77 });
  assert.equal(T.tidyCurrent(u), 77);
  assert.deepEqual(u.queue, [77, 11]);
  assert.deepEqual(s.queue, [10, 11]);
});

test("closed without a batchId has no undo batch", () => {
  const s = T.tidyApply(T.tidyInit([1, 2]), { type: "closed" });
  assert.equal(T.tidyLastUndoBatch(s), null);
  assert.equal(Object.prototype.hasOwnProperty.call(s.history[0], "batchId"), false);
});

test("tidyLastUndoBatch is null when the top history entry is not closed", () => {
  let s = T.tidyInit([1, 2, 3]);
  assert.equal(T.tidyLastUndoBatch(s), null);
  s = T.tidyApply(s, { type: "closed", batchId: "b1" });
  s = T.tidyApply(s, { type: "keep" });
  assert.equal(T.tidyLastUndoBatch(s), null);
});

test("undo on a fresh state returns the same state", () => {
  const s = T.tidyInit([1, 2]);
  const u = T.tidyApply(s, { type: "undo" });
  assert.equal(u, s);
  assert.deepEqual(u, T.tidyInit([1, 2]));
});

test("undo chain keep, slept, closed steps back 3 -> 2 -> 1 -> 0 and clears stats", () => {
  let s = T.tidyInit([1, 2, 3]);
  s = T.tidyApply(s, { type: "keep" });
  s = T.tidyApply(s, { type: "slept" });
  s = T.tidyApply(s, { type: "closed", batchId: "b1" });
  assert.equal(s.pos, 3);
  for (const expected of [2, 1, 0]) {
    s = T.tidyApply(s, { type: "undo" });
    assert.equal(s.pos, expected);
  }
  assert.deepEqual(s.stats, { closed: 0, kept: 0, slept: 0 });
  assert.deepEqual(s.history, []);
  assert.equal(T.tidyCurrent(s), 1);
});

test("undo from the summary brings back the last card", () => {
  let s = T.tidyInit([1, 2]);
  s = T.tidyApply(s, { type: "keep" });
  s = T.tidyApply(s, { type: "keep" });
  assert.equal(s.pos, s.queue.length);
  assert.equal(T.tidyCurrent(s), null);
  s = T.tidyApply(s, { type: "undo" });
  assert.equal(T.tidyCurrent(s), 2);
  assert.equal(s.stats.kept, 1);
});

test("skip advances without touching stats", () => {
  let s = T.tidyInit([1, 2]);
  s = T.tidyApply(s, { type: "skip" });
  assert.equal(T.tidyCurrent(s), 2);
  assert.deepEqual(s.stats, { closed: 0, kept: 0, slept: 0 });
  // The vanished tab leaves the queue, so "N left" counts only real tabs.
  assert.deepEqual(s.queue, [2]);
  assert.equal(s.pos, 0);
  assert.equal(s.queue.length - s.pos, 1);
});

test("skip is not recorded: undo after skip returns to the last real decision", () => {
  let s = T.tidyInit([1, 2, 3]);
  s = T.tidyApply(s, { type: "keep" });
  s = T.tidyApply(s, { type: "skip" });
  assert.equal(s.pos, 1);
  assert.equal(T.tidyCurrent(s), 3);
  s = T.tidyApply(s, { type: "undo" });
  assert.equal(s.pos, 0);
  assert.equal(s.stats.kept, 0);
  assert.equal(T.tidyCurrent(s), 1);
  // Keeping again walks 1 -> 3: the vanished 2 is never shown again.
  s = T.tidyApply(s, { type: "keep" });
  assert.equal(T.tidyCurrent(s), 3);
});

test("undo after slept with newId decrements slept and returns to the replaced id", () => {
  let s = T.tidyInit([5, 6]);
  s = T.tidyApply(s, { type: "slept", newId: 99 });
  s = T.tidyApply(s, { type: "undo" });
  assert.equal(s.pos, 0);
  assert.equal(s.stats.slept, 0);
  // The discarded tab now lives under the new id, so that is what undo shows.
  assert.equal(T.tidyCurrent(s), 99);
});

test("replace swaps an id in the queue without touching pos, history or stats", () => {
  let s = T.tidyInit([1, 2, 3]);
  s = T.tidyApply(s, { type: "keep" });
  deepFreeze(s);
  const r = T.tidyApply(s, { type: "replace", oldId: 3, newId: 30 });
  assert.deepEqual(r.queue, [1, 2, 30]);
  assert.deepEqual(s.queue, [1, 2, 3]);
  assert.equal(r.pos, s.pos);
  assert.equal(r.history, s.history);
  assert.deepEqual(r.stats, s.stats);
});

test("replace with an id not in the queue returns the same state", () => {
  const s = T.tidyInit([1, 2, 3]);
  assert.equal(T.tidyApply(s, { type: "replace", oldId: 9, newId: 90 }), s);
});

test("unknown, missing or null actions return the same state", () => {
  const s = T.tidyInit([1, 2]);
  for (const a of [{ type: "toString" }, { type: "constructor" }, { type: "bogus" }, {}, null, undefined]) {
    assert.equal(T.tidyApply(s, a), s);
  }
});

test("tidyApply never mutates its input state", () => {
  const actions = [
    { type: "keep" },
    { type: "closed", batchId: "b1" },
    { type: "slept", newId: 42 },
    { type: "replace", oldId: 4, newId: 40 },
    { type: "skip" },
    { type: "undo", newId: 43 },
  ];
  let s = T.tidyInit([1, 2, 3, 4, 5]);
  for (const a of actions) {
    const before = JSON.stringify(s);
    deepFreeze(s);
    const next = T.tidyApply(s, a);
    assert.equal(JSON.stringify(s), before);
    assert.notEqual(next, s);
    s = next;
  }
});

test("actions after the end of the queue leave the state unchanged", () => {
  let s = T.tidyInit([1]);
  s = T.tidyApply(s, { type: "keep" });
  for (const a of [{ type: "keep" }, { type: "closed", batchId: "b2" }, { type: "slept" }, { type: "skip" }]) {
    assert.equal(T.tidyApply(s, a), s);
  }
  assert.deepEqual(s.stats, { closed: 0, kept: 1, slept: 0 });
});

test("forget drops the top history entry and its dead tab, keeping stats", () => {
  let s = T.tidyInit([1, 2, 3]);
  s = T.tidyApply(s, { type: "keep" });
  s = T.tidyApply(s, { type: "closed", batchId: "gone" });
  deepFreeze(s);
  const f = T.tidyApply(s, { type: "forget" });
  assert.deepEqual(f.queue, [1, 3]);
  assert.equal(f.pos, 1);
  assert.equal(T.tidyCurrent(f), 3);
  assert.deepEqual(f.stats, { closed: 1, kept: 1, slept: 0 });
  assert.deepEqual(f.history, [{ type: "keep", pos: 0 }]);
  assert.equal(T.tidyLastUndoBatch(f), null);
  // The next undo reaches the step before the forgotten one.
  const u = T.tidyApply(f, { type: "undo" });
  assert.equal(u.pos, 0);
  assert.deepEqual(u.stats, { closed: 1, kept: 0, slept: 0 });
});

test("forget: undoing past a lost close never shows the closed tab again (review repro)", () => {
  const A = 1, B = 2, C = 3;
  let s = T.tidyInit([A, B, C]);
  s = T.tidyApply(s, { type: "keep" }); // K A
  s = T.tidyApply(s, { type: "closed", batchId: "lost" }); // X B, its batch later lost
  s = T.tidyApply(s, { type: "forget" }); // U -> "Couldn't reopen"
  assert.equal(T.tidyCurrent(s), C);
  s = T.tidyApply(s, { type: "undo" }); // U -> back to A
  assert.equal(T.tidyCurrent(s), A);
  s = T.tidyApply(s, { type: "keep" }); // K A
  assert.equal(T.tidyCurrent(s), C, "B is not offered again");
  s = T.tidyApply(s, { type: "keep" }); // K C
  assert.equal(T.tidyCurrent(s), null);
  assert.deepEqual(s.stats, { closed: 1, kept: 2, slept: 0 });
  assert.equal(T.tidySummaryText(s.stats), "Closed 1 · kept 2 · slept 0");
});

test("forget works on the summary and is a no-op with no history", () => {
  let s = T.tidyApply(T.tidyInit([1]), { type: "closed", batchId: "b" });
  assert.equal(T.tidyCurrent(s), null);
  const f = T.tidyApply(s, { type: "forget" });
  assert.deepEqual(f.history, []);
  assert.deepEqual(f.queue, []);
  assert.equal(T.tidyCurrent(f), null);
  const fresh = T.tidyInit([1]);
  assert.equal(T.tidyApply(fresh, { type: "forget" }), fresh);
});

test("tidySummaryText formats the end-of-queue line", () => {
  assert.equal(T.tidySummaryText({ closed: 12, kept: 20, slept: 5 }), "Closed 12 · kept 20 · slept 5");
  assert.equal(T.tidySummaryText(T.tidyInit([]).stats), "Closed 0 · kept 0 · slept 0");
});
