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
//   managerPresent, logoutAt (ms or null), keepAliveUrl,
//   server ("ok" | "redirect" | "error" | "timeout"), disabled (content script switched off),
//   unreachable (sendMessage throws, like a tab with no live content script).
// A successful nudge also rewrites the shared cookie jar, as eRA's page would.
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
  var failures = { get: 0, setDiagnosticLog: 0, cookies: 0 };
  var onChanged = listenerSlot();
  var onCookieChanged = listenerSlot();
  var jar = [];

  function eraCookie(value) {
    return { name: "ERA_SESSION_TIMEOUT_COOKIE", value: String(value), domain: ".era.nih.gov", path: "/" };
  }
  function fireCookie(info) {
    return Promise.all(onCookieChanged.listeners.map(function (fn) { return fn(clone(info)); }));
  }
  // Like Chrome: a rewrite is a removal with cause "overwrite", then a set.
  function setEraCookie(value) {
    var events = [];
    var old = jar.shift();
    if (old) events.push({ removed: true, cause: "overwrite", cookie: old });
    var fresh = eraCookie(value);
    jar.push(fresh);
    events.push({ removed: false, cause: "explicit", cookie: fresh });
    return Promise.all(events.map(fireCookie));
  }
  // eRA's createCookie(name, '', -1) is reported as "expired_overwrite".
  function deleteEraCookie(cause) {
    var old = jar.shift();
    if (!old) return Promise.resolve();
    return fireCookie({ removed: true, cause: cause || "expired_overwrite", cookie: old });
  }
  if (typeof options.cookie === "number") jar.push(eraCookie(options.cookie));

  function reply(tab, message) {
    var page = tab.page;
    var now = Date.now();
    var minsLeft = typeof page.logoutAt === "number" ? (page.logoutAt - now) / MINUTE : null;
    var urlPath = new URL(tab.url).pathname;
    if (message.type === "probe") {
      return { path: urlPath, managerPresent: page.managerPresent, logoutAt: page.logoutAt, minsLeft: minsLeft, keepAliveUrl: page.keepAliveUrl, disabled: !!page.disabled };
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
      serverError: false,
      serverTimeout: false,
      disabled: !!page.disabled
    };
    if (page.disabled || !page.managerPresent || minsLeft === null || minsLeft <= 0) return result;
    tab.nudges += 1;
    page.logoutAt = now + 45 * MINUTE;
    setEraCookie(page.logoutAt);
    result.logoutAtAfter = page.logoutAt;
    result.minsLeftAfter = 45;
    if (message.ping && page.keepAliveUrl) {
      tab.pings += 1;
      result.serverCalled = true;
      if (page.server === "redirect") result.serverRejected = true;
      else if (page.server === "error") result.serverError = true;
      else if (page.server === "timeout") result.serverTimeout = true;
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
    cookies: {
      getAll: async function (details) {
        if (failures.cookies > 0) {
          failures.cookies -= 1;
          throw new Error("cookies unavailable");
        }
        return clone(jar.filter(function (cookie) { return !details.name || cookie.name === details.name; }));
      },
      get: async function (details) {
        return clone(jar.find(function (cookie) { return cookie.name === details.name; }) || null);
      },
      onChanged: onCookieChanged
    },
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

  return {
    bg: context, chrome: chrome, store: store, alarms: alarms, tabs: tabs, calls: calls, failures: failures,
    jar: jar, setEraCookie: setEraCookie, deleteEraCookie: deleteEraCookie,
    // Resolves once every status task queued so far has run.
    drain: function () { return context.serialized(function () {}); }
  };
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
  assert.equal(fromLoggedIn.store.logoutRecords[0].reason, "login or logout page (eRA timer cookie deleted)");

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
    storage: { sessionStatus: "logged-in", sessionStartedAt: Date.now() - 90 * MINUTE, pingServer: false },
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

test("no eRA tabs but a live cookie goes idle, stops the alarm and does not notify", async function () {
  var logoutAt = Date.now() + 30 * MINUTE;
  var fake = makeFake({
    storage: { sessionStatus: "logged-in", sessionStartedAt: 5 },
    cookie: logoutAt,
    tabs: [eraTab(9, "https://www.era.nih.gov/news")]
  });
  fake.alarms["era-keep-alive"] = { name: "era-keep-alive", periodInMinutes: 4 };
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fake.store.sessionStatus, "idle");
  assert.equal(fake.store.sessionStartedAt, 5);
  assert.equal(typeof fake.store.idleSince, "number");
  assert.equal(fake.store.eraLogoutAt, logoutAt);
  assert.equal(fake.alarms["era-keep-alive"], undefined);
  assert.equal(fake.calls.notifications.length, 0);
  assert.equal((fake.store.logoutRecords || []).length, 0);
  assert.equal(fake.calls.sent.length, 0);
  assert.equal(fake.calls.badgeText[fake.calls.badgeText.length - 1], "…");
  assert.ok(logLines(fake).some(function (line) {
    return /no eRA tabs open, cookie 30\.0 min; not keeping the session alive until an eRA tab is open \(4-minute timer stopped\)$/.test(line);
  }), logLines(fake).join("\n"));
});

test("no eRA tabs and no cookie after logged-in records the logout", async function () {
  var fake = makeFake({
    storage: { sessionStatus: "logged-in", sessionStartedAt: Date.now() - 20 * MINUTE, eraLogoutAt: Date.now() + MINUTE },
    tabs: []
  });
  fake.alarms["era-keep-alive"] = { name: "era-keep-alive", periodInMinutes: 4 };
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fake.store.sessionStatus, "logged-out");
  assert.equal(fake.store.eraLogoutAt, null);
  assert.equal(fake.store.logoutRecords.length, 1);
  assert.equal(fake.store.logoutRecords[0].reason, "eRA timer cookie deleted");
  assert.equal(fake.calls.notifications.length, 1);
  assert.equal(fake.alarms["era-keep-alive"], undefined);
  assert.ok(logLines(fake).some(function (line) { return line.endsWith("no eRA tabs open, cookie deleted"); }));
});

test("no eRA tabs and no cookie from unknown or logged-out goes to unknown without a record", async function () {
  for (var prior of ["unknown", "logged-out"]) {
    var fake = makeFake({ storage: { sessionStatus: prior }, tabs: [] });
    await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
    assert.equal(fake.store.sessionStatus, "unknown");
    assert.equal((fake.store.logoutRecords || []).length, 0);
    assert.equal(fake.calls.notifications.length, 0);
  }
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

  var off = makeFake({ storage: { sessionStatus: "logged-in", pingServer: false }, tabs: tabsWithTwoApps() });
  await off.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.deepEqual(off.tabs.map(function (tab) { return tab.pings; }), [0, 0, 0]);
  assert.deepEqual(off.tabs.map(function (tab) { return tab.nudges; }), [1, 1, 1]);
  assert.ok(off.store.diagnosticLog.filter(function (entry) { return entry.type === "nudge"; })
    .every(function (entry) { return entry.pingServer === false; }));
  assert.ok(logLines(off).some(function (line) { return line.endsWith("server not called (ping off)"); }));

  // With nothing stored the switch is on: that is the default since 1.4.3.
  var on = makeFake({ storage: { sessionStatus: "logged-in" }, tabs: tabsWithTwoApps() });
  await on.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.deepEqual(on.tabs.map(function (tab) { return tab.pings; }), [1, 0, 1]);
  assert.deepEqual(on.tabs.map(function (tab) { return tab.nudges; }), [1, 1, 1]);
  assert.equal(on.store.sessionStatus, "logged-in");
  assert.equal(on.store.lastServerResult, "server 200");
  assert.ok(logLines(on).some(function (line) { return line.endsWith("server 200"); }));
});

test("a keep-alive redirect with a live cookie warns but keeps the session and the alarm", async function () {
  var fake = makeFake({
    storage: { sessionStatus: "logged-in", pingServer: true, sessionStartedAt: 7 },
    tabs: [eraTab(1, HOME, liveManager({ keepAliveUrl: ALIVE_URL, server: "redirect" }))]
  });
  fake.alarms["era-keep-alive"] = { name: "era-keep-alive", periodInMinutes: 4 };
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  await fake.drain();
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.equal(fake.store.sessionStartedAt, 7);
  assert.equal((fake.store.logoutRecords || []).length, 0);
  assert.equal(fake.calls.notifications.length, 0);
  assert.ok(fake.alarms["era-keep-alive"]);
  assert.ok(fake.store.serverWarning);
  assert.equal(fake.calls.badgeText[fake.calls.badgeText.length - 1], "ON!");
  var lines = logLines(fake);
  assert.ok(lines.some(function (line) { return line.endsWith("server rejected (redirect)"); }), lines.join("\n"));
  assert.ok(lines.some(function (line) { return /server rejected keep-alive \(redirect\) \/commonsplus\/home\.era; eRA timer still live, still nudging$/.test(line); }));

  // The next tick nudges again; a normal answer clears the warning.
  fake.tabs[0].page.server = "ok";
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fake.tabs[0].nudges, 2);
  assert.equal(fake.store.serverWarning, null);
  assert.equal(fake.calls.badgeText[fake.calls.badgeText.length - 1], "ON");
});

test("a server timeout is logged and keeps the session", async function () {
  var fake = makeFake({
    storage: { sessionStatus: "logged-in", pingServer: true },
    tabs: [eraTab(1, HOME, liveManager({ keepAliveUrl: ALIVE_URL, server: "timeout" }))]
  });
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.equal(fake.store.lastServerResult, "server timeout");
  assert.ok(logLines(fake).some(function (line) { return line.endsWith("server timeout"); }));
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

test("install injects the content script into open eRA tabs and defaults the ping on", async function () {
  var fake = makeFake({ tabs: [eraTab(1, HOME, liveManager()), eraTab(2, LOGIN, { unreachable: true })] });
  fake.chrome.runtime.onInstalled.listeners.forEach(function (fn) { fn({ reason: "install" }); });
  await settle();
  assert.deepEqual(fake.calls.executeScript.map(function (call) { return call.target.tabId; }), [1, 2]);
  assert.deepEqual(Array.from(fake.calls.executeScript[0].files), ["src/matcher.js", "content.js"]);
  assert.equal(fake.store.pingServer, true);
  assert.equal(fake.store.pingDefaultOnApplied, true);
  assert.equal(fake.store.enabled, true);
  assert.ok(fake.alarms["era-keep-alive"]);
});

async function installEvent(storage, details) {
  var fake = makeFake({ storage: storage, tabs: [] });
  fake.chrome.runtime.onInstalled.listeners.forEach(function (fn) { fn(details); });
  await settle();
  return fake.store;
}

test("an update from before 1.4.3 turns the server ping on once, then respects the user's choice", async function () {
  var updated = await installEvent({ pingServer: false, enabled: true }, { reason: "update", previousVersion: "1.4.2" });
  assert.equal(updated.pingServer, true);
  assert.equal(updated.pingDefaultOnApplied, true);
  assert.equal((await installEvent({ pingServer: false }, { reason: "update", previousVersion: "1.2.0" })).pingServer, true);

  // The user turned it off after the migration: later updates, reloads and
  // Chrome updates leave it off.
  var turnedOff = { pingServer: false, enabled: true, pingDefaultOnApplied: true };
  assert.equal((await installEvent(turnedOff, { reason: "update", previousVersion: "1.4.2" })).pingServer, false);
  assert.equal((await installEvent(turnedOff, { reason: "update", previousVersion: "1.4.3" })).pingServer, false);
  assert.equal((await installEvent(turnedOff, { reason: "chrome_update" })).pingServer, false);

  // An update from 1.4.3 or later never overrides a stored choice.
  var later = await installEvent({ pingServer: false, enabled: true }, { reason: "update", previousVersion: "1.4.3" });
  assert.equal(later.pingServer, false);
  assert.equal(later.pingDefaultOnApplied, true);
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

test("eRA deleting its cookie while logged-in ends the session at once, with one record and one notification", async function () {
  var fake = makeFake({
    storage: { sessionStatus: "logged-in", sessionStartedAt: Date.now() - 50 * MINUTE },
    cookie: Date.now() + 40 * MINUTE,
    tabs: [eraTab(1, HOME, liveManager())]
  });
  fake.alarms["era-keep-alive"] = { name: "era-keep-alive", periodInMinutes: 4 };
  await fake.deleteEraCookie("expired_overwrite");
  await fake.drain();
  assert.equal(fake.store.sessionStatus, "logged-out");
  assert.equal(fake.store.logoutRecords.length, 1);
  assert.equal(fake.store.logoutRecords[0].reason, "eRA timer cookie deleted");
  assert.equal(fake.store.logoutRecords[0].minutesSinceSignIn, 50);
  assert.equal(fake.calls.notifications.length, 1);
  assert.equal(fake.alarms["era-keep-alive"], undefined);
  assert.equal(fake.calls.sent.length, 0);
  assert.ok(logLines(fake).some(function (line) { return line.endsWith("status logged-in -> logged-out: eRA timer cookie deleted"); }));
});

test("an explicit cookie removal ends the session; an 'expired' one says so", async function () {
  var explicit = makeFake({ storage: { sessionStatus: "logged-in" }, cookie: Date.now() + 10 * MINUTE, tabs: [] });
  await explicit.deleteEraCookie("explicit");
  await explicit.drain();
  assert.equal(explicit.store.logoutRecords[0].reason, "eRA timer cookie deleted");
  assert.equal(explicit.calls.notifications.length, 1);

  var expired = makeFake({ storage: { sessionStatus: "logged-in" }, cookie: Date.now() + 10 * MINUTE, tabs: [] });
  await expired.deleteEraCookie("expired");
  await expired.drain();
  assert.equal(expired.store.logoutRecords[0].reason, "eRA timer cookie expired");
});

test("a cookie rewrite (overwrite) is not a logout", async function () {
  var first = Date.now() + 30 * MINUTE;
  var fake = makeFake({
    storage: { sessionStatus: "logged-in", sessionStartedAt: 3, eraLogoutAt: first },
    cookie: first,
    tabs: [eraTab(1, HOME, liveManager())]
  });
  var later = Date.now() + 45 * MINUTE;
  await fake.setEraCookie(later);
  await fake.drain();
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.equal(fake.store.sessionStartedAt, 3);
  assert.equal((fake.store.logoutRecords || []).length, 0);
  assert.equal(fake.calls.notifications.length, 0);
  assert.equal(fake.store.eraLogoutAt, later);
});

test("a removal that is immediately replaced by a live cookie ends nothing", async function () {
  var fake = makeFake({ storage: { sessionStatus: "logged-in" }, cookie: Date.now() + 30 * MINUTE, tabs: [] });
  var removal = fake.deleteEraCookie("explicit");
  fake.jar.push({ name: "ERA_SESSION_TIMEOUT_COOKIE", value: String(Date.now() + 44 * MINUTE), domain: ".era.nih.gov", path: "/" });
  await removal;
  await fake.drain();
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.equal(fake.calls.notifications.length, 0);
});

test("a fresh cookie write after a logout sets logged-in and re-arms the alarm", async function () {
  var fake = makeFake({ storage: { sessionStatus: "logged-out" }, tabs: [eraTab(1, HOME, liveManager())] });
  var at = Date.now();
  var logoutAt = at + 45 * MINUTE;
  await fake.setEraCookie(logoutAt);
  await fake.drain();
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.ok(fake.store.sessionStartedAt >= at);
  assert.equal(fake.store.eraLogoutAt, logoutAt);
  assert.equal(fake.calls.badgeText[fake.calls.badgeText.length - 1], "ON");
  assert.ok(fake.alarms["era-keep-alive"]);
});

test("cookies from other sites and cookie events while disabled are ignored", async function () {
  var fake = makeFake({ storage: { sessionStatus: "logged-in", enabled: false }, cookie: Date.now() + 30 * MINUTE, tabs: [] });
  await fake.deleteEraCookie("explicit");
  fake.chrome.cookies.onChanged.listeners.forEach(function (fn) {
    fn({ removed: true, cause: "explicit", cookie: { name: "ERA_SESSION_TIMEOUT_COOKIE", value: "1", domain: ".example.com" } });
  });
  await fake.drain();
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.equal(fake.calls.notifications.length, 0);
});

test("a tick with only unreachable tabs keeps logged-in, and a later real logout is still recorded", async function () {
  var startedAt = Date.now() - 60 * MINUTE;
  var fake = makeFake({
    storage: { sessionStatus: "logged-in", sessionStartedAt: startedAt },
    cookie: Date.now() + 30 * MINUTE,
    tabs: [eraTab(1, HOME, { unreachable: true })]
  });
  // Cookie unreadable too: nothing but neutral evidence.
  fake.failures.cookies = 1;
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.equal(fake.store.sessionStartedAt, startedAt);

  // Unreachable tab, cookie readable and live: still logged in.
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.equal(fake.store.sessionStartedAt, startedAt);

  await fake.deleteEraCookie();
  await fake.drain();
  assert.equal(fake.store.sessionStatus, "logged-out");
  assert.equal(fake.store.logoutRecords.length, 1);
  assert.equal(fake.store.logoutRecords[0].minutesSinceSignIn, 60);
  assert.equal(fake.calls.notifications.length, 1);
});

test("an unreachable tab sitting on eRA's logout URL counts as a logout once the cookie is gone", async function () {
  var fake = makeFake({
    storage: { sessionStatus: "logged-in" },
    tabs: [eraTab(1, "https://public.era.nih.gov/commons/authi/public/do?action=logout", { unreachable: true })]
  });
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fake.store.sessionStatus, "logged-out");
  assert.equal(fake.store.logoutRecords[0].reason, "login or logout page (eRA timer cookie deleted)");
});

test("a login page that still saw eRA's timer running is recorded as eRA's server ending the session", async function () {
  // From a real log: nudges kept eRA's page timer at 45 min, then eRA sent the
  // tab to its login page while the page still showed 45 min left.
  var fake = makeFake({ storage: { sessionStatus: "logged-in", pingServer: false }, tabs: [eraTab(1, "https://public.era.nih.gov/assist/public/login.era")] });
  await fake.bg.handleMessage(pageReady({ path: "/assist/public/login.era", isLoginPage: true, managerPresent: false, minsLeft: 45 }), { tab: { id: 1 } });
  await fake.drain();
  assert.equal(fake.store.sessionStatus, "logged-out");
  var record = fake.store.logoutRecords[0];
  assert.equal(record.reason, "eRA sent you to its login page while its page timer still had 45 min left — eRA's server ended the session");
  assert.doesNotMatch(record.reason, /cookie deleted/);
  assert.equal(matcher.logoutNote(record),
    "eRA's server ended this session even though its page timer was still running. Keep \"Also ping eRA's server\" on.");
  assert.ok(logLines(fake).some(function (line) { return /status logged-in -> logged-out: eRA sent you to its login page while its page timer still had 45 min left/.test(line); }));
});

test("a login tab with a live cookie stays logged-in and keeps nudging", async function () {
  var fake = makeFake({
    storage: { sessionStatus: "logged-in", sessionStartedAt: 9 },
    cookie: Date.now() + 30 * MINUTE,
    tabs: [eraTab(1, LOGIN), eraTab(2, "https://public.era.nih.gov/commons/authi/public/do?action=logout", { unreachable: true })]
  });
  fake.alarms["era-keep-alive"] = { name: "era-keep-alive", periodInMinutes: 4 };
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  await fake.bg.handleMessage(pageReady({ path: "/commonsplus/public/login.era", isLoginPage: true, managerPresent: false, minsLeft: null }), { tab: { id: 1 } });
  await fake.drain();
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.equal(fake.store.sessionStartedAt, 9);
  assert.equal((fake.store.logoutRecords || []).length, 0);
  assert.equal(fake.calls.notifications.length, 0);
  assert.ok(fake.alarms["era-keep-alive"]);
});

test("returning after idle with a past cookie value records the end quietly, with an estimate", async function () {
  var lastDeadline = Date.now() - 3 * 60 * MINUTE;
  var fake = makeFake({
    storage: { sessionStatus: "idle", sessionStartedAt: Date.now() - 5 * 60 * MINUTE, idleSince: lastDeadline - 40 * MINUTE, eraLogoutAt: lastDeadline },
    cookie: lastDeadline,
    tabs: [eraTab(1, LOGIN)]
  });
  await fake.bg.handleMessage(pageReady({ path: "/commonsplus/public/login.era", isLoginPage: true, managerPresent: false, minsLeft: null }), { tab: { id: 1 } });
  await fake.drain();
  assert.equal(fake.store.sessionStatus, "logged-out");
  assert.equal(fake.store.idleSince, null);
  assert.equal(fake.store.logoutRecords.length, 1);
  var record = fake.store.logoutRecords[0];
  assert.equal(record.reason, "ended while no eRA tab was open");
  assert.equal(record.estimatedEndAt, lastDeadline);
  assert.ok(record.loggedOutDetectedAt > lastDeadline);
  assert.equal(fake.calls.notifications.length, 0);
  assert.doesNotMatch(matcher.logoutNote(record) || "", /hard limit/);
});

test("an idle session whose cookie is deleted, or an alarm with no cookie, ends without a notification", async function () {
  var deadline = Date.now() + 20 * MINUTE;
  var deleted = makeFake({ storage: { sessionStatus: "idle", idleSince: Date.now(), eraLogoutAt: deadline }, cookie: deadline, tabs: [] });
  await deleted.deleteEraCookie("explicit");
  await deleted.drain();
  assert.equal(deleted.store.sessionStatus, "logged-out");
  assert.equal(deleted.store.logoutRecords[0].reason, "ended while no eRA tab was open");
  assert.ok(deleted.store.logoutRecords[0].estimatedEndAt <= Date.now());
  assert.equal(deleted.calls.notifications.length, 0);

  var ticked = makeFake({ storage: { sessionStatus: "idle", idleSince: Date.now(), eraLogoutAt: Date.now() - MINUTE }, tabs: [] });
  await ticked.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(ticked.store.sessionStatus, "logged-out");
  assert.equal(ticked.store.logoutRecords.length, 1);
  assert.equal(ticked.calls.notifications.length, 0);
});

test("returning after idle with a live cookie is logged-in again, with no record and the same sign-in time", async function () {
  var fake = makeFake({
    storage: { sessionStatus: "idle", sessionStartedAt: 5, idleSince: Date.now() - 10 * MINUTE, eraLogoutAt: Date.now() + 20 * MINUTE },
    cookie: Date.now() + 20 * MINUTE,
    tabs: [eraTab(1, HOME, liveManager())]
  });
  await fake.bg.handleMessage(pageReady(), { tab: { id: 1 } });
  await fake.drain();
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.equal(fake.store.sessionStartedAt, 5);
  assert.equal(fake.store.idleSince, null);
  assert.equal((fake.store.logoutRecords || []).length, 0);
  assert.equal(fake.calls.notifications.length, 0);
  assert.equal(fake.calls.badgeText[fake.calls.badgeText.length - 1], "ON");
  assert.ok(fake.alarms["era-keep-alive"]);
});

test("a live cookie event while idle with no tab open stays idle", async function () {
  var fake = makeFake({ storage: { sessionStatus: "idle", idleSince: Date.now(), eraLogoutAt: Date.now() + 5 * MINUTE }, cookie: Date.now() + 5 * MINUTE, tabs: [] });
  await fake.setEraCookie(Date.now() + 30 * MINUTE);
  await fake.drain();
  assert.equal(fake.store.sessionStatus, "idle");
  assert.equal(fake.calls.notifications.length, 0);
});

test("after a browser restart with no cookie, a live or idle session is recorded as ended at the stored logout time", async function () {
  for (var prior of ["idle", "logged-in"]) {
    var deadline = Date.now() - 30 * MINUTE;
    var fake = makeFake({ storage: { sessionStatus: prior, sessionStartedAt: Date.now() - 2 * 60 * MINUTE, eraLogoutAt: deadline }, tabs: [] });
    fake.chrome.runtime.onStartup.listeners.forEach(function (fn) { fn(); });
    await settle();
    await fake.drain();
    assert.equal(fake.store.sessionStatus, "logged-out", prior);
    assert.equal(fake.store.logoutRecords.length, 1);
    assert.equal(fake.store.logoutRecords[0].estimatedEndAt, deadline);
    assert.equal(fake.store.logoutRecords[0].reason, "ended while no eRA tab was open");
    assert.equal(fake.calls.notifications.length, 0, prior);
  }
});

test("minutesLeftAtLastNudge is the timer at the nudge, not a later cookie write", async function () {
  var fake = makeFake({ storage: { sessionStatus: "logged-in" }, tabs: [eraTab(1, HOME, liveManager())] });
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  await fake.drain();
  // eRA pushes its cookie well ahead after user activity; that moves eraLogoutAt only.
  await fake.setEraCookie(Date.now() + 90 * MINUTE);
  await fake.drain();
  assert.ok(fake.store.eraLogoutAt > fake.store.lastNudgeTimerAt);
  await fake.deleteEraCookie("expired_overwrite");
  await fake.drain();
  assert.equal(fake.store.logoutRecords[0].minutesLeftAtLastNudge, 45);
});

test("a tab whose content script is switched off is neither nudged, pinged nor counted", async function () {
  var fake = makeFake({
    storage: { sessionStatus: "unknown", pingServer: true },
    tabs: [eraTab(1, HOME, liveManager({ keepAliveUrl: ALIVE_URL, disabled: true }))]
  });
  await fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() });
  assert.equal(fake.tabs[0].nudges, 0);
  assert.equal(fake.tabs[0].pings, 0);
  assert.equal(fake.store.sessionStatus, "unknown");
});

test("after a logout, a page without eRA's timer does not restart the alarm; a live one does", async function () {
  var fake = makeFake({ storage: { sessionStatus: "logged-out" }, tabs: [eraTab(1, HOME)] });
  await fake.bg.handleMessage(pageReady({ path: "/commonsplus/help.era", managerPresent: false, minsLeft: null }), { tab: { id: 1 } });
  assert.equal(fake.alarms["era-keep-alive"], undefined);
  await fake.bg.handleMessage(pageReady({ managerPresent: true, minsLeft: 44 }), { tab: { id: 1 } });
  assert.equal(fake.store.sessionStatus, "logged-in");
  assert.ok(fake.alarms["era-keep-alive"]);
});

test("a cookie deletion, a login page load and a tick at the same moment notify once", async function () {
  var fake = makeFake({
    storage: { sessionStatus: "logged-in" },
    cookie: Date.now() + 30 * MINUTE,
    tabs: [eraTab(1, LOGIN), eraTab(2, HOME, { managerPresent: true, logoutAt: null })]
  });
  var removed = fake.jar[0];
  fake.jar.length = 0;
  function removal(cause) {
    return Promise.all(fake.chrome.cookies.onChanged.listeners.map(function (fn) {
      return fn({ removed: true, cause: cause, cookie: removed });
    }));
  }
  // Two eRA tabs each delete the cookie as they log out, while a page load
  // and an alarm tick land at the same moment.
  await Promise.all([
    removal("expired_overwrite"),
    removal("explicit"),
    fake.bg.handleMessage(pageReady({ path: "/commonsplus/public/login.era", isLoginPage: true, managerPresent: false, minsLeft: null }), { tab: { id: 1 } }),
    fake.bg.nudgeEraTabs({ name: "era-keep-alive", scheduledTime: Date.now() })
  ]);
  await fake.drain();
  assert.equal(fake.store.sessionStatus, "logged-out");
  assert.equal(fake.store.logoutRecords.length, 1);
  assert.equal(fake.calls.notifications.length, 1);
  var statusLines = logLines(fake).filter(function (line) { return line.includes("status logged-in -> logged-out"); });
  assert.equal(statusLines.length, 1);
});
