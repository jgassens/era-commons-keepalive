"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

var ROOT = path.join(__dirname, "..");
var MINUTE = 60000;
var matcher = require("../src/matcher.js");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

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

// A fake eRA tab. `page` mimics what content.js would see and do:
//   managerPresent, logoutAt (ms or null), keepAliveUrl, server ("ok" | "redirect" | "error"),
//   unreachable (sendMessage throws, like a tab with no live content script).
function eraTab(id, url, page) {
  page = Object.assign({ managerPresent: false, logoutAt: null, keepAliveUrl: null, server: "ok" }, page);
  return { id: id, url: url, page: page, pings: 0, nudges: 0 };
}

function makeFake(options) {
  options = options || {};
  var store = Object.assign({}, clone(options.storage || {}));
  var alarms = {};
  var tabs = options.tabs || [];
  var calls = { notifications: [], executeScript: [], badgeText: [], sent: [] };
  var failures = { get: 0, setDiagnosticLog: 0 };
  var onChanged = listenerSlot();

  function reply(tab, message) {
    var page = tab.page;
    var now = Date.now();
    var minsLeft = typeof page.logoutAt === "number" ? (page.logoutAt - now) / MINUTE : null;
    var urlPath = new URL(tab.url).pathname;
    if (message.type === "probe") {
      return { path: urlPath, managerPresent: page.managerPresent, logoutAt: page.logoutAt, minsLeft: minsLeft, keepAliveUrl: page.keepAliveUrl };
    }
    var result = {
      path: urlPath,
      managerPresent: page.managerPresent,
      minsLeftBefore: minsLeft,
      minsLeftAfter: minsLeft,
      logoutAtAfter: page.logoutAt,
      serverCalled: false,
      serverStatus: null,
      serverRejected: false,
      serverError: false
    };
    if (!page.managerPresent || minsLeft === null || minsLeft <= 0) return result;
    tab.nudges += 1;
    page.logoutAt = now + 45 * MINUTE;
    result.logoutAtAfter = page.logoutAt;
    result.minsLeftAfter = 45;
    if (message.ping && page.keepAliveUrl) {
      tab.pings += 1;
      result.serverCalled = true;
      if (page.server === "redirect") result.serverRejected = true;
      else if (page.server === "error") result.serverError = true;
      else result.serverStatus = 200;
    }
    return result;
  }

  var chrome = {
    storage: {
      local: {
        get: async function (keys) {
          if (failures.get > 0) {
            failures.get -= 1;
            throw new Error("storage get failed");
          }
          if (keys === null || keys === undefined) return clone(store);
          if (typeof keys === "string") keys = [keys];
          var out = {};
          if (Array.isArray(keys)) {
            keys.forEach(function (key) { if (key in store) out[key] = clone(store[key]); });
            return out;
          }
          Object.keys(keys).forEach(function (key) {
            out[key] = key in store ? clone(store[key]) : clone(keys[key]);
          });
          return out;
        },
        set: async function (values) {
          if ("diagnosticLog" in values && failures.setDiagnosticLog > 0) {
            failures.setDiagnosticLog -= 1;
            throw new Error("storage quota exceeded");
          }
          var changes = {};
          Object.keys(values).forEach(function (key) {
            changes[key] = { oldValue: clone(store[key]), newValue: clone(values[key]) };
            store[key] = clone(values[key]);
          });
          onChanged.listeners.slice().forEach(function (fn) { fn(changes, "local"); });
        }
      },
      onChanged: onChanged
    },
    alarms: {
      create: async function (name, info) { alarms[name] = Object.assign({ name: name }, info); },
      clear: async function (name) { var had = name in alarms; delete alarms[name]; return had; },
      get: async function (name) { return alarms[name]; },
      onAlarm: listenerSlot()
    },
    tabs: {
      query: async function () { return tabs.map(function (tab) { return { id: tab.id, url: tab.url }; }); },
      sendMessage: async function (tabId, message) {
        calls.sent.push({ tabId: tabId, message: message });
        var tab = tabs.find(function (item) { return item.id === tabId; });
        if (!tab || tab.page.unreachable) throw new Error("Could not establish connection. Receiving end does not exist.");
        return reply(tab, message);
      }
    },
    action: {
      setBadgeText: async function (details) { calls.badgeText.push(details.text); },
      setBadgeBackgroundColor: async function () {}
    },
    notifications: { create: async function (id, details) { calls.notifications.push(details); } },
    scripting: {
      executeScript: async function (details) {
        calls.executeScript.push(details);
        var tab = tabs.find(function (item) { return item.id === details.target.tabId; });
        if (tab && tab.page.unreachable) throw new Error("Cannot access contents of the page");
      }
    },
    runtime: { onMessage: listenerSlot(), onInstalled: listenerSlot(), onStartup: listenerSlot() }
  };

  var context = {
    chrome: chrome,
    URL: URL,
    console: { warn: function () {}, log: function () {}, error: function () {} },
    importScripts: function (file) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), context, { filename: "background.js" });

  return { bg: context, chrome: chrome, store: store, alarms: alarms, tabs: tabs, calls: calls, failures: failures };
}

async function settle() {
  for (var i = 0; i < 30; i += 1) await new Promise(function (resolve) { setImmediate(resolve); });
}

function logLines(fake) {
  return (fake.store.diagnosticLog || []).map(matcher.formatLogLine);
}

function liveManager(extra) {
  return Object.assign({ managerPresent: true, logoutAt: Date.now() + 30 * MINUTE }, extra);
}

function pageReady(fields) {
  return Object.assign({
    type: "era-page-ready",
    at: Date.now(),
    path: "/commonsplus/home.era",
    ignored: false,
    isLoginPage: false,
    managerPresent: true,
    minsLeft: 44
  }, fields);
}

var HOME = "https://public.era.nih.gov/commonsplus/home.era";
var LOGIN = "https://public.era.nih.gov/commonsplus/public/login.era";
var ALIVE_URL = "https://public.era.nih.gov/commonsplus/jsp/keepSessionAlive.jsp";

test("login and non-manager page loads do not reset lastUserPageLoadAt", async function () {
  var fake = makeFake({ storage: { sessionStatus: "logged-out", lastUserPageLoadAt: 111 }, tabs: [eraTab(1, LOGIN)] });
  await settle();
  await fake.bg.handleMessage(pageReady({ path: "/commonsplus/public/login.era", isLoginPage: true, managerPresent: false, minsLeft: null }), { tab: { id: 1 } });
  await fake.bg.handleMessage(pageReady({ path: "/commonsplus/help.era", managerPresent: false, minsLeft: 20 }), { tab: { id: 1 } });
  assert.equal(fake.store.lastUserPageLoadAt, 111);

  var at = Date.now();
  await fake.bg.handleMessage(pageReady({ at: at }), { tab: { id: 1 } });
  assert.equal(fake.store.lastUserPageLoadAt, at);
});

test("logout record and notification both happen only on logged-in -> logged-out", async function () {
  var fromLoggedIn = makeFake({ storage: { sessionStatus: "logged-in" }, tabs: [eraTab(1, LOGIN)] });
  await fromLoggedIn.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fromLoggedIn.store.sessionStatus, "logged-out");
  assert.equal(fromLoggedIn.store.logoutRecords.length, 1);
  assert.equal(fromLoggedIn.calls.notifications.length, 1);
  assert.equal(fromLoggedIn.store.logoutRecords[0].reason, "login or logout page");

  var fromUnknown = makeFake({ storage: { sessionStatus: "unknown" }, tabs: [eraTab(1, LOGIN)] });
  await fromUnknown.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fromUnknown.store.sessionStatus, "logged-out");
  assert.equal((fromUnknown.store.logoutRecords || []).length, 0);
  assert.equal(fromUnknown.calls.notifications.length, 0);
});

test("an unreachable tab is logged as such and does not block logout detection", async function () {
  var fake = makeFake({
    storage: { sessionStatus: "logged-in" },
    tabs: [eraTab(1, HOME, { unreachable: true }), eraTab(2, LOGIN)]
  });
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  var lines = logLines(fake);
  assert.ok(lines.some(function (line) { return /nudge \/commonsplus\/home\.era: could not reach tab \(reload it\)$/.test(line); }), lines.join("\n"));
  assert.ok(!lines.some(function (line) { return line.includes("timeout manager not present"); }));
  assert.equal(fake.store.sessionStatus, "logged-out");
  assert.equal(fake.store.logoutRecords.length, 1);
  assert.equal(fake.calls.notifications.length, 1);
});

test("a deleted cookie after logged-in means logged-out", async function () {
  var fake = makeFake({
    storage: { sessionStatus: "logged-in", sessionStartedAt: Date.now() - 90 * MINUTE },
    tabs: [eraTab(1, HOME, { managerPresent: true, logoutAt: null })]
  });
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fake.store.sessionStatus, "logged-out");
  var record = fake.store.logoutRecords[0];
  assert.equal(record.reason, "cookie deleted");
  assert.equal(record.minutesSinceSignIn, 90);
  assert.equal(record.pingServer, false);
  assert.equal(fake.alarms["era-keep-alive"], undefined);
  assert.ok(logLines(fake).some(function (line) { return line.endsWith("cookie deleted, server not called (ping off)"); }));
});

test("with no eRA tabs the status becomes unknown and the alarm is cleared", async function () {
  var fake = makeFake({ storage: { sessionStatus: "logged-in", eraLogoutAt: Date.now() + MINUTE }, tabs: [eraTab(9, "https://www.era.nih.gov/news")] });
  fake.alarms["era-keep-alive"] = { name: "era-keep-alive", periodInMinutes: 4 };
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fake.store.sessionStatus, "unknown");
  assert.equal(fake.store.eraLogoutAt, null);
  assert.equal(fake.alarms["era-keep-alive"], undefined);
  assert.ok(logLines(fake).some(function (line) { return line.includes("no eRA tabs open"); }));
  assert.equal(fake.calls.sent.length, 0);
});

test("while disabled, page loads are not logged and tabs are not nudged", async function () {
  var fake = makeFake({ storage: { enabled: false, sessionStatus: "unknown" }, tabs: [eraTab(1, HOME, liveManager())] });
  await fake.bg.handleMessage(pageReady(), { tab: { id: 1 } });
  await fake.bg.handleMessage({ type: "auto-click", at: Date.now(), path: "/commonsplus/home.era" }, { tab: { id: 1 } });
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  await settle();
  assert.equal((fake.store.diagnosticLog || []).length, 0);
  assert.equal(fake.store.lastUserPageLoadAt, undefined);
  assert.equal(fake.store.lastAutoClick, undefined);
  assert.equal(fake.calls.sent.length, 0);
  assert.equal(fake.tabs[0].nudges, 0);
});

test("the server is pinged only when the switch is on, once per keep-alive URL", async function () {
  var otherUrl = "https://public.era.nih.gov/commons/jsp/keepSessionAlive.jsp";
  function tabsWithTwoApps() {
    return [
      eraTab(1, HOME, liveManager({ keepAliveUrl: ALIVE_URL })),
      eraTab(2, HOME + "?x=2", liveManager({ keepAliveUrl: ALIVE_URL })),
      eraTab(3, "https://public.era.nih.gov/commons/home", liveManager({ keepAliveUrl: otherUrl }))
    ];
  }

  var off = makeFake({ storage: { sessionStatus: "logged-in" }, tabs: tabsWithTwoApps() });
  await off.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.deepEqual(off.tabs.map(function (tab) { return tab.pings; }), [0, 0, 0]);
  assert.deepEqual(off.tabs.map(function (tab) { return tab.nudges; }), [1, 1, 1]);
  assert.ok(off.store.diagnosticLog.filter(function (entry) { return entry.type === "nudge"; })
    .every(function (entry) { return entry.pingServer === false; }));
  assert.ok(logLines(off).some(function (line) { return line.endsWith("server not called (ping off)"); }));

  var on = makeFake({ storage: { sessionStatus: "logged-in", pingServer: true }, tabs: tabsWithTwoApps() });
  await on.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.deepEqual(on.tabs.map(function (tab) { return tab.pings; }), [1, 0, 1]);
  assert.deepEqual(on.tabs.map(function (tab) { return tab.nudges; }), [1, 1, 1]);
  assert.equal(on.store.sessionStatus, "logged-in");
  assert.equal(on.store.lastServerResult, "server 200");
  assert.ok(logLines(on).some(function (line) { return line.endsWith("server 200"); }));
});

test("a keep-alive redirect counts as server rejected and ends the session", async function () {
  var fake = makeFake({
    storage: { sessionStatus: "logged-in", pingServer: true },
    tabs: [eraTab(1, HOME, liveManager({ keepAliveUrl: ALIVE_URL, server: "redirect" }))]
  });
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fake.store.sessionStatus, "logged-out");
  assert.equal(fake.store.logoutRecords[0].reason, "server rejected keep-alive (redirect)");
  assert.equal(fake.store.logoutRecords[0].pingServer, true);
  assert.equal(fake.calls.notifications.length, 1);
  assert.ok(logLines(fake).some(function (line) { return line.endsWith("server rejected (redirect)"); }));
});

test("a server error is logged but does not end the session", async function () {
  var fake = makeFake({
    storage: { sessionStatus: "logged-in", pingServer: true },
    tabs: [eraTab(1, HOME, liveManager({ keepAliveUrl: ALIVE_URL, server: "error" }))]
  });
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.ok(logLines(fake).some(function (line) { return line.endsWith("server error"); }));
});

test("a storage failure does not stop later ticks or later log writes", async function () {
  var fake = makeFake({ storage: { sessionStatus: "unknown" }, tabs: [eraTab(1, HOME, liveManager())] });
  await settle();
  fake.failures.get = 1;
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  fake.failures.setDiagnosticLog = 1;
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  await fake.bg.logWrite;
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.ok(fake.store.diagnosticLog.some(function (entry) { return entry.type === "nudge"; }));
});

test("a login page load ends a logged-in session immediately", async function () {
  var fake = makeFake({ storage: { sessionStatus: "logged-in" }, tabs: [eraTab(1, LOGIN)] });
  fake.alarms["era-keep-alive"] = { name: "era-keep-alive", periodInMinutes: 4 };
  await fake.bg.handleMessage(pageReady({ path: "/commonsplus/public/login.era", isLoginPage: true, managerPresent: false, minsLeft: null }), { tab: { id: 1 } });
  assert.equal(fake.store.sessionStatus, "logged-out");
  assert.equal(fake.store.logoutRecords.length, 1);
  assert.equal(fake.calls.notifications.length, 1);
  assert.equal(fake.alarms["era-keep-alive"], undefined);
});

test("the logout is recorded even when the tab has already left eRA", async function () {
  var fake = makeFake({ storage: { sessionStatus: "logged-in" }, tabs: [] });
  await fake.bg.handleMessage(pageReady({ path: "/commons/authi/public/do", isLoginPage: true, managerPresent: false, minsLeft: null }), { tab: { id: 1 } });
  assert.equal(fake.store.sessionStatus, "logged-out");
  assert.equal(fake.store.logoutRecords.length, 1);
});

test("a live manager page after logout sets logged-in and clears the red badge at once", async function () {
  var fake = makeFake({ storage: { sessionStatus: "logged-out" }, tabs: [eraTab(1, HOME, liveManager())] });
  var at = Date.now();
  await fake.bg.handleMessage(pageReady({ at: at }), { tab: { id: 1 } });
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.equal(fake.store.sessionStartedAt, at);
  assert.equal(fake.calls.badgeText[fake.calls.badgeText.length - 1], "ON");
  assert.ok(fake.alarms["era-keep-alive"]);
});

test("ignored pages do not create the alarm or appear in the log", async function () {
  var fake = makeFake({ storage: { sessionStatus: "unknown" }, tabs: [eraTab(9, "https://www.era.nih.gov/news")] });
  await fake.bg.handleMessage(pageReady({ path: "/news", ignored: true, managerPresent: false }), { tab: { id: 9 } });
  await fake.bg.configureAlarm();
  assert.equal(fake.alarms["era-keep-alive"], undefined);
  assert.equal((fake.store.diagnosticLog || []).length, 0);
});

test("install injects the content script into open eRA tabs and defaults the ping off", async function () {
  var fake = makeFake({ tabs: [eraTab(1, HOME, liveManager()), eraTab(2, LOGIN, { unreachable: true })] });
  fake.chrome.runtime.onInstalled.listeners.forEach(function (fn) { fn({ reason: "update" }); });
  await settle();
  assert.deepEqual(fake.calls.executeScript.map(function (call) { return call.target.tabId; }), [1, 2]);
  assert.deepEqual(Array.from(fake.calls.executeScript[0].files), ["src/matcher.js", "content.js"]);
  assert.equal(fake.store.pingServer, false);
  assert.equal(fake.store.enabled, true);
  assert.ok(fake.alarms["era-keep-alive"]);
});

test("a late alarm is logged", async function () {
  var fake = makeFake({ storage: { sessionStatus: "logged-in" }, tabs: [eraTab(1, HOME, liveManager())] });
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() - 30 * MINUTE });
  assert.ok(logLines(fake).some(function (line) { return /alarm late by 30\.0 min \(computer asleep\?\)/.test(line); }));
});

test("the post-nudge logout time comes straight from the cookie", async function () {
  var fake = makeFake({ storage: { sessionStatus: "logged-in" }, tabs: [eraTab(1, HOME, liveManager())] });
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fake.store.eraLogoutAt, fake.tabs[0].page.logoutAt);
});
