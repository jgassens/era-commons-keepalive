"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var recorder = require("../src/recorder.js");

function fakeStorage(options) {
  options = options || {};
  var store = {};
  var calls = { sets: 0, removes: 0 };
  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
  return {
    store: store,
    calls: calls,
    get: async function (keys) {
      if (keys === null) return clone(store);
      if (typeof keys === "string") keys = [keys];
      var out = {};
      keys.forEach(function (key) { if (key in store) out[key] = clone(store[key]); });
      return out;
    },
    set: async function (values) {
      calls.sets += 1;
      if (options.quotaBytes && JSON.stringify(Object.assign({}, store, values)).length > options.quotaBytes) {
        throw new Error("QUOTA_BYTES quota exceeded");
      }
      Object.keys(values).forEach(function (key) { store[key] = clone(values[key]); });
    },
    remove: async function (keys) {
      calls.removes += 1;
      [].concat(keys).forEach(function (key) { delete store[key]; });
    }
  };
}

function numbered(from, count) {
  var events = [];
  for (var i = from; i < from + count; i += 1) events.push({ t: i, event: "completed", n: i });
  return events;
}

test("only nih.gov and login.gov hosts are recorded", function () {
  ["nih.gov", "public.era.nih.gov", "auth.nih.gov", "login.gov", "secure.login.gov", ".era.nih.gov"].forEach(function (host) {
    assert.equal(recorder.isRecordedHost(host), true, host);
  });
  ["evilnih.gov", "nih.gov.example.com", "example.com", "notlogin.gov", ""].forEach(function (host) {
    assert.equal(recorder.isRecordedHost(host), false, host);
  });
  assert.equal(recorder.requestEvent("request", { url: "https://nih.gov.example.com/a" }, null, null, 1), null);
});

test("request events keep only host and a safe path: no query, fragment or ;params", function () {
  var event = recorder.requestEvent("completed", {
    requestId: 12, url: "https://public.era.nih.gov/a;jsessionid=XYZ/b.era;x=1?user=me&token=T#h", method: "post",
    type: "main_frame", tabId: 4, statusCode: 200, fromCache: true, initiator: "https://public.era.nih.gov/should/not/appear?x", timeStamp: 5.6
  }, "chrome-extension://me", null, 1);
  assert.deepEqual(event, {
    t: 6, event: "completed", requestId: "12", method: "POST", host: "public.era.nih.gov", path: "/a/b.era",
    type: "main_frame", tabId: 4, initiator: "https://public.era.nih.gov", statusCode: 200, fromCache: true
  });
  assert.equal(recorder.initiatorLabel("chrome-extension://me", "chrome-extension://me"), "this-extension");
  assert.equal(recorder.initiatorLabel("chrome-extension://other", "chrome-extension://me"), "other-extension");
});

test("Set-Cookie headers give names only, and Location gives host and safe path", function () {
  var headers = [
    { name: "set-cookie", value: "A=secretA; Path=/\nB_2=secretB; HttpOnly" },
    { name: "Set-Cookie", value: "=noName" },
    { name: "Set-Cookie", value: "bad name=x" },
    { name: "Location", value: "../login.era;jsessionid=Q?next=secret#x" }
  ];
  assert.deepEqual(recorder.setCookieNames(headers), ["A", "B_2"]);
  assert.deepEqual(recorder.locationTarget(headers, "https://public.era.nih.gov/app/sub/page.era"),
    { host: "public.era.nih.gov", path: "/app/login.era" });
  assert.equal(JSON.stringify(recorder.setCookieNames(headers)).indexOf("secret"), -1);
});

test("cookie events never hold the value, only a salted 6-hex fingerprint and its length", async function () {
  var value = "1768485389636";
  var change = { removed: true, cause: "overwrite", cookie: {
    name: "ERA_SESSION_TIMEOUT_COOKIE", value: value, domain: ".era.nih.gov", path: "/", session: false,
    expirationDate: 1768489000.5, httpOnly: false, secure: true, sameSite: "no_restriction"
  } };
  var fp = await recorder.fingerprintValue(value, "salt-1", globalThis.crypto.subtle);
  var event = recorder.cookieEvent(change, fp, 99);
  assert.match(event.fp, /^[0-9a-f]{6}$/);
  assert.equal(event.len, value.length);
  assert.equal(event.expirationDate, 1768489000.5);
  assert.equal(event.session, undefined);
  assert.equal(event.removed, true);
  assert.equal(event.cause, "overwrite");
  assert.equal(JSON.stringify(event).indexOf(value), -1);
  assert.equal(Object.hasOwn(event, "value"), false);
  // The same value fingerprints the same; another salt or value does not.
  assert.equal((await recorder.fingerprintValue(value, "salt-1", globalThis.crypto.subtle)).fp, event.fp);
  assert.notEqual((await recorder.fingerprintValue(value, "salt-2", globalThis.crypto.subtle)).fp, event.fp);
  assert.notEqual((await recorder.fingerprintValue(value + "1", "salt-1", globalThis.crypto.subtle)).fp, event.fp);
  // Without crypto: still no value, just the length.
  assert.deepEqual(await recorder.fingerprintValue(value, "s", null), { fp: null, len: value.length });
  assert.equal(recorder.isRecordedCookie({ cookie: { domain: ".example.com" } }), false);
});

test("page events are limited to known kinds on eRA hosts, with safe paths", function () {
  var event = recorder.pageEvent({ what: "navigate", at: 5, path: "/a;jsessionid=1?q=2", fromPath: "/b?c", visibility: "hidden", persisted: false },
    "https://public.era.nih.gov/a?q=2", 9, 1);
  assert.deepEqual(event, { t: 5, event: "page", what: "navigate", host: "public.era.nih.gov", path: "/a", fromPath: "/b", tabId: 9, visibility: "hidden", persisted: false });
  assert.equal(recorder.pageEvent({ what: "keypress" }, "https://public.era.nih.gov/", 1, 1), null);
  assert.equal(recorder.pageEvent({ what: "load" }, "https://example.com/", 1, 1), null);
});

test("only session-boundary diagnostic entries are mirrored", function () {
  assert.equal(recorder.sessionEvent({ type: "page-load", at: 1, path: "/x" }), null);
  assert.equal(recorder.sessionEvent({ type: "nudge", at: 1, serverCalled: false }), null);
  assert.deepEqual(recorder.sessionEvent({ type: "status", at: 1, from: "logged-in", to: "logged-out", reason: "r", path: null }),
    { t: 1, event: "session", what: "status", from: "logged-in", to: "logged-out", reason: "r" });
  assert.equal(recorder.sessionEvent({ type: "nudge", at: 1, serverCalled: true, serverStatus: 204 }).serverStatus, 204);
});

test("the rolling buffer keeps at most 20,000 events, newest kept, in chunks", async function () {
  var storage = fakeStorage();
  var index;
  for (var from = 0; from < 25000; from += 1250) index = await recorder.appendToRecording(storage, numbered(from, 1250));
  assert.ok(index.count <= recorder.MAX_EVENTS, String(index.count));
  assert.ok(index.count > recorder.MAX_EVENTS - recorder.CHUNK_SIZE, String(index.count));
  var recording = await recorder.readRecording(storage);
  assert.equal(recording.events.length, index.count);
  assert.equal(recording.events[recording.events.length - 1].n, 24999);
  assert.equal(recording.events[0].n, 25000 - index.count);
  assert.equal(recording.index.dropped, 25000 - index.count);
  // Every chunk key in storage is one the index knows; none is over size.
  var chunkKeys = Object.keys(storage.store).filter(function (key) { return key.indexOf("recording-") === 0; });
  assert.equal(chunkKeys.length, index.chunks.length);
  chunkKeys.forEach(function (key) { assert.ok(storage.store[key].length <= recorder.CHUNK_SIZE); });
});

test("each batch is one write that touches only the newest chunk and the index", async function () {
  var storage = fakeStorage();
  await recorder.appendToRecording(storage, numbered(0, 1200));
  var written = [];
  var set = storage.set;
  storage.set = function (values) { written.push(Object.keys(values).sort()); return set(values); };
  await recorder.appendToRecording(storage, numbered(1200, 10));
  assert.deepEqual(written, [["recording", "recording-2"]]);
  assert.equal(storage.store["recording-2"].length, 210);
});

test("a write refused for quota drops the oldest part and still saves the batch", async function () {
  var storage = fakeStorage({ quotaBytes: 60000 });
  var index;
  for (var from = 0; from < 3000; from += 100) index = await recorder.appendToRecording(storage, numbered(from, 100), { chunkSize: 100 });
  var recording = await recorder.readRecording(storage);
  assert.equal(recording.events[recording.events.length - 1].n, 2999);
  assert.ok(index.dropped > 0);
  assert.ok(JSON.stringify(storage.store).length <= 60000);
});

test("clearing removes the index and every chunk, even ones a write left behind", async function () {
  var storage = fakeStorage();
  await recorder.appendToRecording(storage, numbered(0, 700));
  storage.store["recording-99"] = [{ t: 1 }];
  storage.store.keepMe = 1;
  await recorder.clearRecording(storage);
  assert.deepEqual(Object.keys(storage.store), ["keepMe"]);
  assert.equal((await recorder.readRecording(storage)).events.length, 0);
});

test("the exported file carries the events and no salt", async function () {
  var storage = fakeStorage();
  await recorder.appendToRecording(storage, numbered(0, 3));
  var file = recorder.exportRecording(await recorder.readRecording(storage), { extensionVersion: "1.6.0", exportedAt: 0 });
  assert.equal(file.format, "era-session-keeper-recording");
  assert.equal(file.count, 3);
  assert.equal(file.exportedAt, "1970-01-01T00:00:00.000Z");
  assert.match(recorder.exportFileName(Date.now()), /^era-recording-\d{8}-\d{4}\.json$/);
});
