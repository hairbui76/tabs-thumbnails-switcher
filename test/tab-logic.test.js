"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const L = require("../tab-logic.js");

const API_NAMES = [
  "normalizeUrl",
  "sleepCandidates",
  "duplicatePlan",
  "tidyQueue",
  "formatGB",
  "sleepToastText",
  "dedupeToastText",
  "memoryLineText",
  "matchClosedSessions",
  "replaceTabId",
];

const GB = 2 ** 30;

function tab(id, props) {
  return Object.assign(
    { id: id, url: "https://example.com/" + id, pinned: false, audible: false, discarded: false, autoDiscardable: true },
    props || {}
  );
}

// Loading

test("module.exports exposes exactly the ten functions", () => {
  assert.deepEqual(Object.keys(L).sort(), API_NAMES.slice().sort());
});

test("loading like importScripts attaches all ten functions to self", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "tab-logic.js"), "utf8");
  const self = {};
  vm.runInNewContext(src, { self: self, URL: URL });
  for (const name of API_NAMES) {
    assert.equal(typeof self[name], "function", name);
  }
  assert.equal(self.normalizeUrl("https://a.com/x#y"), "https://a.com/x");
  assert.equal(self.sleepToastText({ slept: 2, failed: 0, freedBytes: 1.8 * 2 ** 30 }), "Put 2 tabs to sleep · freed ~1.8 GB");
});

test("internal calls do not go through the replaceable globals", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "tab-logic.js"), "utf8");
  const self = {};
  vm.runInNewContext(src, { self: self, URL: URL });
  self.normalizeUrl = () => "same";
  self.formatGB = () => "bogus";
  const tabs = [
    { id: 1, url: "https://a.com/" },
    { id: 2, url: "https://b.com/" },
  ];
  // Array.from: the vm context has its own Array prototype.
  assert.deepEqual(Array.from(self.duplicatePlan(tabs, [], 99).toClose), []);
  assert.equal(self.memoryLineText({ available: 2.9 * 2 ** 30, capacity: 16 * 2 ** 30 }), "RAM: 2.9 GB free of 16 GB");
});

// normalizeUrl

test("normalizeUrl drops the fragment and keeps the query", () => {
  assert.equal(L.normalizeUrl("https://a.com/x?p=2#top"), "https://a.com/x?p=2");
});

test("normalizeUrl keeps different query strings apart", () => {
  assert.notEqual(L.normalizeUrl("https://a.com/x?p=2"), L.normalizeUrl("https://a.com/x?p=3"));
});

test("normalizeUrl returns an empty string for empty input", () => {
  assert.equal(L.normalizeUrl(""), "");
  assert.equal(L.normalizeUrl(undefined), "");
  assert.equal(L.normalizeUrl(null), "");
});

test("normalizeUrl returns an unparsable URL unchanged", () => {
  assert.equal(L.normalizeUrl("not a url"), "not a url");
});

test("normalizeUrl lowercases the host and drops the default port", () => {
  assert.equal(L.normalizeUrl("https://A.COM:443/x"), "https://a.com/x");
});

test("normalizeUrl leaves about:blank as is", () => {
  assert.equal(L.normalizeUrl("about:blank"), "about:blank");
});

// sleepCandidates

test("sleepCandidates excludes active, pinned, audible, discarded and non-auto-discardable tabs", () => {
  const tabs = [
    tab(1),
    tab(2, { pinned: true }),
    tab(3, { audible: true }),
    tab(4, { discarded: true }),
    tab(5, { autoDiscardable: false }),
    tab(6),
    tab(7),
  ];
  assert.deepEqual(L.sleepCandidates(tabs, 1), [6, 7]);
});

test("sleepCandidates is empty when only the active tab and pinned tabs exist", () => {
  assert.deepEqual(L.sleepCandidates([tab(1)], 1), []);
  assert.deepEqual(L.sleepCandidates([tab(1), tab(2, { pinned: true })], 1), []);
});

// duplicatePlan

test("duplicatePlan keeps the active tab and counts the whole group", () => {
  const tabs = [
    tab(1, { url: "https://a.com/#x" }),
    tab(2, { url: "https://a.com/" }),
    tab(3, { url: "https://a.com/#y" }),
  ];
  const plan = L.duplicatePlan(tabs, [1, 2, 3], 3);
  assert.deepEqual(plan.toClose, [1, 2]);
  assert.deepEqual(plan.dupCount, { 1: 3, 2: 3, 3: 3 });
});

test("duplicatePlan keeps a pinned tab over a more recently used one", () => {
  const tabs = [
    tab(9, { url: "https://b.com/" }),
    tab(2, { url: "https://a.com/", pinned: true }),
    tab(3, { url: "https://a.com/" }),
  ];
  const plan = L.duplicatePlan(tabs, [3, 2], 9);
  assert.deepEqual(plan.toClose, [3]);
  assert.deepEqual(plan.dupCount, { 2: 2, 3: 2 });
});

test("duplicatePlan keeps the most recently used copy", () => {
  const tabs = [tab(4, { url: "https://a.com/" }), tab(5, { url: "https://a.com/" })];
  assert.deepEqual(L.duplicatePlan(tabs, [5, 4], 99).toClose, [4]);
});

test("duplicatePlan: a tab absent from the MRU list loses to one present", () => {
  const tabs = [tab(4, { url: "https://a.com/" }), tab(5, { url: "https://a.com/" })];
  assert.deepEqual(L.duplicatePlan(tabs, [5], 99).toClose, [4]);
  assert.deepEqual(L.duplicatePlan(tabs, [4], 99).toClose, [5]);
});

test("duplicatePlan keeps both of two pinned copies", () => {
  const tabs = [tab(1, { url: "https://a.com/", pinned: true }), tab(2, { url: "https://a.com/", pinned: true })];
  const plan = L.duplicatePlan(tabs, [2, 1], 99);
  assert.deepEqual(plan.toClose, []);
  assert.deepEqual(plan.dupCount, { 1: 2, 2: 2 });
});

test("duplicatePlan never closes a pinned copy when the active tab is kept", () => {
  const tabs = [
    tab(1, { url: "https://a.com/", pinned: true }),
    tab(2, { url: "https://a.com/" }),
    tab(3, { url: "https://a.com/" }),
  ];
  assert.deepEqual(L.duplicatePlan(tabs, [3, 1, 2], 2).toClose, [3]);
});

test("duplicatePlan ignores empty URLs", () => {
  const tabs = [tab(1, { url: "" }), tab(2, { url: "" })];
  const plan = L.duplicatePlan(tabs, [1, 2], 99);
  assert.deepEqual(plan.toClose, []);
  assert.deepEqual(plan.dupCount, {});
});

test("duplicatePlan never groups about:blank tabs", () => {
  const tabs = [tab(1, { url: "about:blank" }), tab(2, { url: "about:blank" }), tab(3, { url: "about:blank#x" })];
  const plan = L.duplicatePlan(tabs, [1, 2, 3], 99);
  assert.deepEqual(plan.toClose, []);
  assert.deepEqual(plan.dupCount, {});
});

test("duplicatePlan groups chrome://newtab/ tabs", () => {
  const tabs = [tab(1, { url: "chrome://newtab/" }), tab(2, { url: "chrome://newtab/" })];
  const plan = L.duplicatePlan(tabs, [2, 1], 99);
  assert.deepEqual(plan.toClose, [1]);
  assert.deepEqual(plan.dupCount, { 1: 2, 2: 2 });
});

test("duplicatePlan keeps an active tab that is also pinned, and other pinned copies", () => {
  const tabs = [
    tab(1, { url: "https://a.com/" }),
    tab(2, { url: "https://a.com/", pinned: true }),
    tab(3, { url: "https://a.com/", pinned: true }),
  ];
  const plan = L.duplicatePlan(tabs, [1, 3, 2], 2);
  assert.deepEqual(plan.toClose, [1]);
  assert.deepEqual(plan.dupCount, { 1: 3, 2: 3, 3: 3 });
});

test("duplicatePlan is not confused by a __proto__ URL key", () => {
  const tabs = [tab(1, { url: "__proto__" }), tab(2, { url: "__proto__" })];
  assert.deepEqual(L.duplicatePlan(tabs, [2, 1], 99).toClose, [1]);
});

test("duplicatePlan groups identical unparsable URLs as raw strings", () => {
  const tabs = [tab(1, { url: "not a url" }), tab(2, { url: "not a url" }), tab(3, { url: "not a url#x" })];
  const plan = L.duplicatePlan(tabs, [2, 1, 3], 99);
  assert.deepEqual(plan.toClose, [1]);
  assert.deepEqual(plan.dupCount, { 1: 2, 2: 2 });
});

test("duplicatePlan with no duplicates closes nothing", () => {
  const tabs = [tab(1), tab(2), tab(3)];
  assert.deepEqual(L.duplicatePlan(tabs, [1, 2, 3], 1), { toClose: [], dupCount: {} });
});

// tidyQueue

test("tidyQueue orders oldest first, missing stamps first, excluding active and pinned", () => {
  const tabs = [tab(1), tab(2, { pinned: true }), tab(3), tab(4), tab(5)];
  assert.deepEqual(L.tidyQueue(tabs, { 1: 500, 2: 50, 3: 300, 5: 100 }, 1), [4, 5, 3]);
});

test("tidyQueue is empty when every tab is pinned or active", () => {
  const tabs = [tab(1), tab(2, { pinned: true }), tab(3, { pinned: true })];
  assert.deepEqual(L.tidyQueue(tabs, { 2: 10, 3: 20 }, 1), []);
});

test("tidyQueue keeps input order for equal stamps", () => {
  const tabs = [tab(7), tab(3), tab(5), tab(1)];
  assert.deepEqual(L.tidyQueue(tabs, { 7: 100, 3: 100, 1: 100 }, 99), [5, 7, 3, 1]);
  assert.deepEqual(L.tidyQueue(tabs, null, 99), [7, 3, 5, 1]);
});

// formatGB

test("formatGB uses one decimal below 10 GB and none at or above", () => {
  assert.equal(L.formatGB(1.8 * GB), "1.8 GB");
  assert.equal(L.formatGB(16 * GB), "16 GB");
  assert.equal(L.formatGB(10 * GB), "10 GB");
});

test("formatGB does not print 10.0 when a value just below 10 GB rounds up", () => {
  assert.equal(L.formatGB(9.96 * GB), "10 GB");
  assert.equal(L.formatGB(9.94 * GB), "9.9 GB");
});

// sleepToastText

test("sleepToastText includes the freed figure when positive", () => {
  assert.equal(
    L.sleepToastText({ slept: 12, failed: 0, freedBytes: 1.8 * GB }),
    "Put 12 tabs to sleep · freed ~1.8 GB"
  );
});

test("sleepToastText omits a negative or unknown figure", () => {
  assert.equal(L.sleepToastText({ slept: 12, failed: 0, freedBytes: -5 }), "Put 12 tabs to sleep");
  assert.equal(L.sleepToastText({ slept: 12, failed: 0, freedBytes: null }), "Put 12 tabs to sleep");
  assert.equal(L.sleepToastText({ slept: 12, failed: 0, freedBytes: 0 }), "Put 12 tabs to sleep");
  assert.equal(L.sleepToastText({ slept: 12, failed: 0, freedBytes: NaN }), "Put 12 tabs to sleep");
});

test("sleepToastText omits a figure that would round to 0.0 GB", () => {
  assert.equal(L.sleepToastText({ slept: 3, failed: 0, freedBytes: 10 * 2 ** 20 }), "Put 3 tabs to sleep");
});

test("sleepToastText uses the singular and reports failures", () => {
  assert.equal(
    L.sleepToastText({ slept: 1, failed: 2, freedBytes: null }),
    "Put 1 tab to sleep · 2 could not sleep"
  );
});

// dedupeToastText

test("dedupeToastText pluralizes", () => {
  assert.equal(L.dedupeToastText(7), "Closed 7 duplicate tabs — the newest copy stays open");
  assert.equal(L.dedupeToastText(1), "Closed 1 duplicate tab — the newest copy stays open");
});

// memoryLineText

test("memoryLineText formats free and total memory", () => {
  assert.equal(L.memoryLineText({ available: 2.9 * GB, capacity: 16 * GB }), "RAM: 2.9 GB free of 16 GB");
});

test("memoryLineText is empty without memory info", () => {
  assert.equal(L.memoryLineText(null), "");
});

test("memoryLineText is empty for invalid numbers", () => {
  const ok = 2.9 * GB;
  assert.equal(L.memoryLineText({ available: ok, capacity: NaN }), "");
  assert.equal(L.memoryLineText({ available: ok, capacity: Infinity }), "");
  assert.equal(L.memoryLineText({ available: ok, capacity: 0 }), "");
  assert.equal(L.memoryLineText({ available: ok, capacity: -16 * GB }), "");
  assert.equal(L.memoryLineText({ available: NaN, capacity: 16 * GB }), "");
  assert.equal(L.memoryLineText({ available: Infinity, capacity: 16 * GB }), "");
  assert.equal(L.memoryLineText({ capacity: 16 * GB }), "");
});

// matchClosedSessions

test("matchClosedSessions uses each session at most once", () => {
  const records = [{ url: "u" }, { url: "u" }, { url: "v" }];
  const sessions = [
    { tab: { url: "u", sessionId: "a" } },
    { window: { sessionId: "w", tabs: [{ url: "u", sessionId: "wt" }] } },
    { tab: { url: "u", sessionId: "b" } },
  ];
  assert.deepEqual(L.matchClosedSessions(records, sessions), ["a", "b", null]);
});

test("matchClosedSessions compares normalized URLs on both sides", () => {
  const records = [{ url: "https://a.com/x#top" }, { url: "https://a.com/x" }];
  const sessions = [
    { tab: { url: "https://a.com/x#other", sessionId: "s1" } },
    { tab: { url: "https://a.com/x", sessionId: "s2" } },
  ];
  assert.deepEqual(L.matchClosedSessions(records, sessions), ["s1", "s2"]);
});

test("matchClosedSessions never matches empty or about:blank records", () => {
  const records = [{ url: "" }, { url: "about:blank" }, { url: "u" }];
  const sessions = [
    { tab: { url: "", sessionId: "e" } },
    { tab: { url: "about:blank", sessionId: "b" } },
    { tab: { url: "u", sessionId: "c" } },
  ];
  assert.deepEqual(L.matchClosedSessions(records, sessions), [null, null, "c"]);
});

test("matchClosedSessions skips a session without a sessionId", () => {
  const records = [{ url: "u" }];
  const sessions = [{ tab: { url: "u" } }, { tab: { url: "u", sessionId: "s" } }];
  assert.deepEqual(L.matchClosedSessions(records, sessions), ["s"]);
});

test("matchClosedSessions returns null for every record when nothing was closed", () => {
  assert.deepEqual(L.matchClosedSessions([{ url: "u" }], []), [null]);
});

// replaceTabId

test("replaceTabId rewrites the old id", () => {
  assert.deepEqual(L.replaceTabId([1, 2, 3], 2, 9), [1, 9, 3]);
});

test("replaceTabId returns an unchanged copy for an unknown id", () => {
  const list = [1, 2, 3];
  const out = L.replaceTabId(list, 7, 9);
  assert.deepEqual(out, [1, 2, 3]);
  assert.notEqual(out, list);
});
