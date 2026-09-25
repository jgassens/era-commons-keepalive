"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

var ROOT = path.join(__dirname, "..");
var MINUTE = 60000;
var MATCHER_SOURCE = fs.readFileSync(path.join(ROOT, "src/matcher.js"), "utf8");
var CONTENT_SOURCE = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");

function listenerSlot() {
  var listeners = [];
  return {
    listeners: listeners,
    addListener: function (fn) { listeners.push(fn); },
    removeListener: function (fn) {
      var index = listeners.indexOf(fn);
      if (index !== -1) listeners.splice(index, 1);
    }
  };
}

// A small element: only what content.js and the matcher touch.
function element(id, options) {
  options = options || {};
  var children = options.children || {};
  return {
    id: id,
    visible: options.visible !== false,
    innerText: options.text || "",
    attributes: options.attributes || {},
    clicks: 0,
    click: function () { this.clicks += 1; },
    getAttribute: function (name) { return name === "id" ? this.id : (name in this.attributes ? this.attributes[name] : null); },
    getClientRects: function () { return this.visible ? [{}] : []; },
    querySelector: function (selector) { return children[selector] || null; },
    querySelectorAll: function () { return []; }
  };
}

// A fake eRA page. options:
//   enabled (stored switch), logoutAt (cookie value or null), manager (timeout control present),
//   sessionStatus (stored status), modalVisible (eRA's Bootstrap timeout modal shown), fetch (replacement fetch), eraPage (true:
//   a scroll renews the cookie like eRA's jQuery handler).
function makePage(options) {
  options = Object.assign({ enabled: true, logoutAt: Date.now() + 30 * MINUTE, manager: true, modalVisible: false, eraPage: true }, options);
  var timers = [];
  var clock = { now: 0 };
  var docListeners = {};
  var calls = { sent: [], fetches: [], scrolls: 0 };
  var cookie = { logoutAt: options.logoutAt };

  var continueButton = element("extendSessionBtn", { text: "Continue" });
  var modal = element("sessionTimeoutModalDialog", {
    visible: options.modalVisible,
    text: "Session Timeout Warning: you will be logged off due to inactivity.",
    children: { "#extendSessionBtn": continueButton }
  });
  var control = element("session-timeout-control", {
    attributes: { "data-base-url": "https://public.era.nih.gov/", "data-current-app-name": "commonsplus" }
  });
  var byId = { sessionTimeoutModalDialog: modal, extendSessionBtn: continueButton };
  if (options.manager) byId["session-timeout-control"] = control;

  var document = {
    get cookie() {
      return "JSESSIONID=abc; " + (cookie.logoutAt === null ? "" : "ERA_SESSION_TIMEOUT_COOKIE=" + cookie.logoutAt);
    },
    documentElement: {},
    getElementById: function (id) { return byId[id] || null; },
    querySelector: function (selector) { return selector.charAt(0) === "#" ? byId[selector.slice(1)] || null : null; },
    querySelectorAll: function () { return []; },
    addEventListener: function (type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener: function (type, fn) {
      var list = docListeners[type] || [];
      var index = list.indexOf(fn);
      if (index !== -1) list.splice(index, 1);
    },
    dispatchEvent: function (event) {
      (docListeners[event.type] || []).slice().forEach(function (fn) { fn(event); });
      return true;
    }
  };
  if (options.eraPage) {
    // eRA's own handler: any scroll pushes the deadline 45 minutes ahead.
    document.addEventListener("scroll", function () {
      calls.scrolls += 1;
      cookie.logoutAt = Date.now() + 45 * MINUTE;
    });
  }

  var chrome = {
    runtime: {
      id: "extension-id",
      onMessage: listenerSlot(),
      sendMessage: function (message) { calls.sent.push(message); return Promise.resolve(); }
    },
    storage: {
      local: { get: function () { return Promise.resolve({ enabled: options.enabled, sessionStatus: options.sessionStatus || "unknown" }); } },
      onChanged: listenerSlot()
    }
  };

  function Event(type) { this.type = type; }
  function CustomEvent(type) { this.type = type; }
  function MutationObserver() {}
  MutationObserver.prototype.observe = function () {};
  MutationObserver.prototype.disconnect = function () {};

  var context = {
    chrome: chrome,
    document: document,
    location: { href: "https://public.era.nih.gov/commonsplus/home.era", pathname: "/commonsplus/home.era" },
    URL: URL,
    Event: Event,
    CustomEvent: CustomEvent,
    MutationObserver: MutationObserver,
    AbortController: AbortController,
    console: console,
    fetch: options.fetch || function (url, init) {
      calls.fetches.push({ url: url, init: init });
      return Promise.resolve({ type: "basic", status: 200, body: null });
    },
    getComputedStyle: function (node) { return { display: node.visible ? "block" : "none", visibility: "visible" }; },
    setTimeout: function (fn, ms) { timers.push({ fn: fn, at: clock.now + ms, repeat: 0 }); return timers.length; },
    clearTimeout: function (id) { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    setInterval: function (fn, ms) { timers.push({ fn: fn, at: clock.now + ms, repeat: ms }); return timers.length; },
    clearInterval: function (id) { if (timers[id - 1]) timers[id - 1].cancelled = true; }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(MATCHER_SOURCE, context, { filename: "src/matcher.js" });

  function load() {
    vm.runInContext(CONTENT_SOURCE, context, { filename: "content.js" });
  }
  // Runs fake timers due within ms of fake time.
  function advance(ms) {
    var until = clock.now + ms;
    for (;;) {
      var due = timers.filter(function (timer) { return !timer.cancelled && timer.at <= until; })
        .sort(function (a, b) { return a.at - b.at; })[0];
      if (!due) break;
      clock.now = due.at;
      if (due.repeat) due.at += due.repeat;
      else due.cancelled = true;
      due.fn();
    }
    clock.now = until;
  }
  // Delivers a message to every content-script listener; resolves with the reply.
  function send(message) {
    return new Promise(function (resolve) {
      chrome.runtime.onMessage.listeners.slice().forEach(function (fn) {
        fn(message, {}, resolve);
      });
    });
  }

  return {
    context: context, chrome: chrome, calls: calls, cookie: cookie, modal: modal,
    continueButton: continueButton, load: load, advance: advance, send: send
  };
}

async function flush() {
  for (var i = 0; i < 10; i += 1) await new Promise(function (resolve) { setImmediate(resolve); });
}

test("reports the page on load, with its timer", async function () {
  var page = makePage();
  page.load();
  await flush();
  var ready = page.calls.sent.find(function (message) { return message.type === "era-page-ready"; });
  assert.ok(ready);
  assert.equal(ready.managerPresent, true);
  assert.equal(ready.isLoginPage, false);
  assert.ok(ready.minsLeft > 29 && ready.minsLeft <= 30);
});

test("while switched off it never scrolls, clicks or pings, and says so", async function () {
  var page = makePage({ enabled: false, modalVisible: true });
  page.load();
  await flush();
  var reply = await page.send({ type: "nudge-activity", ping: true });
  assert.equal(reply.disabled, true);
  assert.equal(page.calls.scrolls, 0);
  assert.equal(page.calls.fetches.length, 0);
  var probe = await page.send({ type: "probe" });
  assert.equal(probe.disabled, true);
  page.advance(60 * 1000);
  assert.equal(page.continueButton.clicks, 0);
  assert.ok(!page.calls.sent.some(function (message) { return message.type === "auto-click"; }));
});

test("a nudge scrolls once so eRA renews its cookie, and reports the new deadline", async function () {
  var page = makePage();
  page.load();
  await flush();
  var reply = await page.send({ type: "nudge-activity", ping: false });
  assert.equal(page.calls.scrolls, 1);
  assert.equal(reply.disabled, false);
  assert.equal(reply.serverCalled, false);
  assert.ok(reply.minsLeftBefore < 31);
  assert.ok(reply.minsLeftAfter > 44.9);
  assert.equal(reply.logoutAtAfter, page.cookie.logoutAt);
  assert.equal(page.calls.fetches.length, 0);
});

test("no scroll when the cookie is gone or the page has no timeout manager", async function () {
  var noCookie = makePage({ logoutAt: null });
  noCookie.load();
  await flush();
  var reply = await noCookie.send({ type: "nudge-activity", ping: true });
  assert.equal(noCookie.calls.scrolls, 0);
  assert.equal(reply.minsLeftBefore, null);
  assert.equal(noCookie.calls.fetches.length, 0);

  var noManager = makePage({ manager: false });
  noManager.load();
  await flush();
  await noManager.send({ type: "nudge-activity", ping: true });
  assert.equal(noManager.calls.scrolls, 0);
});

test("loading twice keeps a single live copy", async function () {
  var page = makePage();
  page.load();
  var first = page.context.__eraKeepAliveContent;
  var firstListener = page.chrome.runtime.onMessage.listeners[0];
  page.load();
  await flush();
  // The live first copy wins: the second one returns before doing anything.
  assert.equal(page.context.__eraKeepAliveContent, first);
  assert.deepEqual(page.chrome.runtime.onMessage.listeners, [firstListener]);
  assert.equal(page.calls.sent.filter(function (message) { return message.type === "era-page-ready"; }).length, 1);
  assert.equal(page.chrome.storage.onChanged.listeners.length, 1);
  await page.send({ type: "nudge-activity", ping: false });
  assert.equal(page.calls.scrolls, 1);
});

test("the ping uses redirect: 'manual', and an opaque redirect counts as server rejected", async function () {
  var fetches = [];
  var page = makePage({
    fetch: function (url, init) {
      fetches.push({ url: url, init: init });
      return Promise.resolve({ type: "opaqueredirect", status: 0, body: null });
    }
  });
  page.load();
  await flush();
  var reply = await page.send({ type: "nudge-activity", ping: true });
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, "https://public.era.nih.gov/commonsplus/jsp/keepSessionAlive.jsp");
  assert.equal(fetches[0].init.redirect, "manual");
  assert.equal(fetches[0].init.credentials, "include");
  assert.ok(fetches[0].init.signal);
  assert.equal(reply.serverCalled, true);
  assert.equal(reply.serverRejected, true);
  assert.equal(reply.serverStatus, null);
  assert.equal(reply.serverError, false);
});

test("a normal answer is recorded as its status", async function () {
  var page = makePage();
  page.load();
  await flush();
  var reply = await page.send({ type: "nudge-activity", ping: true });
  assert.equal(reply.serverStatus, 200);
  assert.equal(reply.serverRejected, false);
  assert.equal(reply.serverTimeout, false);
});

test("a hung ping gives up after 15 seconds and reports a server timeout", async function () {
  var signal = null;
  var page = makePage({
    fetch: function (url, init) {
      signal = init.signal;
      return new Promise(function () {}); // never settles, even when aborted
    }
  });
  page.load();
  await flush();
  var settled = false;
  var replyPromise = page.send({ type: "nudge-activity", ping: true }).then(function (reply) { settled = true; return reply; });
  page.advance(14 * 1000);
  await flush();
  assert.equal(settled, false);
  page.advance(1000);
  var reply = await replyPromise;
  assert.equal(signal.aborted, true);
  assert.equal(reply.serverTimeout, true);
  assert.equal(reply.serverError, false);
  assert.equal(reply.serverStatus, null);
});

test("a failed ping is a server error", async function () {
  var page = makePage({ fetch: function () { return Promise.reject(new TypeError("network down")); } });
  page.load();
  await flush();
  var reply = await page.send({ type: "nudge-activity", ping: true });
  assert.equal(reply.serverError, true);
  assert.equal(reply.serverTimeout, false);
});

test("Continue is pressed only while eRA's timeout modal is visible", async function () {
  var page = makePage({ modalVisible: false });
  page.load();
  await flush();
  page.advance(15 * 1000);
  assert.equal(page.continueButton.clicks, 0);

  page.modal.visible = true;
  page.advance(15 * 1000);
  assert.equal(page.continueButton.clicks, 1);
  await flush();
  assert.ok(page.calls.sent.some(function (message) { return message.type === "auto-click"; }));

  // Not pressed again within the cooldown, even if the modal lingers.
  page.advance(15 * 1000);
  assert.equal(page.continueButton.clicks, 1);
});

test("turning the switch off stops the clicks", async function () {
  var page = makePage({ modalVisible: true });
  page.load();
  await flush();
  assert.equal(page.continueButton.clicks, 1);
  page.chrome.storage.onChanged.listeners.forEach(function (fn) {
    fn({ enabled: { oldValue: true, newValue: false } }, "local");
  });
  page.advance(5 * MINUTE);
  assert.equal(page.continueButton.clicks, 1);
  var reply = await page.send({ type: "nudge-activity", ping: true });
  assert.equal(reply.disabled, true);
  assert.equal(page.calls.scrolls, 0);
});

test("Continue is not pressed while the stored session status is logged-out, and is again once logged in", async function () {
  var page = makePage({ modalVisible: true, sessionStatus: "logged-out" });
  page.load();
  await flush();
  page.advance(60 * 1000);
  assert.equal(page.continueButton.clicks, 0);
  assert.ok(!page.calls.sent.some(function (message) { return message.type === "auto-click"; }));

  page.chrome.storage.onChanged.listeners.forEach(function (fn) {
    fn({ sessionStatus: { oldValue: "logged-out", newValue: "logged-in" } }, "local");
  });
  assert.equal(page.continueButton.clicks, 1);

  // Logged out again: the warning is left for eRA's own logout.
  page.chrome.storage.onChanged.listeners.forEach(function (fn) {
    fn({ sessionStatus: { oldValue: "logged-in", newValue: "logged-out" } }, "local");
  });
  page.advance(5 * MINUTE);
  assert.equal(page.continueButton.clicks, 1);
});
