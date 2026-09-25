"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

var ROOT = path.join(__dirname, "..");
// Synthetic chrome.storage.local shaped like a real logout capture (v1.4.2).
// It mixes v1.2.0 logout records and log entries with current ones. Some
// scalars are garbled the way the leveldb extraction produces them (strings
// starting with ":").
var REAL_STATE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "sample-state.json"), "utf8"));

// Just enough DOM for popup.js: elements by id, created elements, text,
// children and classList. Setting textContent replaces the children, as in
// a browser.
function fakeElement(tag) {
  var classes = [];
  var element = {
    tagName: tag,
    children: [],
    hidden: false,
    checked: false,
    listeners: {},
    _text: "",
    appendChild: function (child) { element.children.push(child); return child; },
    addEventListener: function (type, fn) { element.listeners[type] = fn; },
    classList: {
      add: function () { Array.prototype.slice.call(arguments).forEach(function (c) { if (classes.indexOf(c) === -1) classes.push(c); }); },
      remove: function () { Array.prototype.slice.call(arguments).forEach(function (c) { var i = classes.indexOf(c); if (i !== -1) classes.splice(i, 1); }); },
      contains: function (c) { return classes.indexOf(c) !== -1; }
    }
  };
  Object.defineProperty(element, "className", {
    get: function () { return classes.join(" "); },
    set: function (value) { classes.length = 0; String(value).split(/\s+/).filter(Boolean).forEach(function (c) { classes.push(c); }); }
  });
  Object.defineProperty(element, "textContent", {
    get: function () { return element._text + element.children.map(function (child) { return child.textContent; }).join(""); },
    set: function (value) { element._text = String(value); element.children = []; }
  });
  return element;
}

function renderPopup(state, options) {
  options = options || {};
  var ids = ["enabled", "ping-server", "status", "status-block", "details",
    "dt-signed-in", "signed-in", "dt-last-nudge", "last-nudge",
    "dt-server-checkin", "server-checkin", "dt-last-click", "last-click",
    "session-pattern", "logout-records", "diagnostic-log", "copy-log", "version", "open-tab"];
  var elements = {};
  ids.forEach(function (id) { elements[id] = fakeElement(id === "logout-records" ? "div" : "div"); });
  var warnings = [];
  var tabsCreated = [];
  var context = {
    console: { warn: function () { warnings.push(Array.from(arguments)); }, log: function () {}, error: function () {} },
    document: {
      getElementById: function (id) { return elements[id] || null; },
      createElement: fakeElement
    },
    navigator: { clipboard: { writeText: async function (text) { context.copied = text; } } },
    window: { setTimeout: function () {} },
    tabsCreated: tabsCreated,
    chrome: {
      runtime: {
        getManifest: function () { return { version: "1.4.3" }; },
        getURL: function (path) { return "chrome-extension://fake-extension-id/" + path; }
      },
      tabs: {
        // Rebuilt as a plain object of this realm: the vm context has its own
        // Object, so a literal built inside it fails deepStrictEqual here.
        create: async function (details) {
          if (options.tabsCreateFails) throw new Error("could not create tab");
          tabsCreated.push({ url: details.url });
        }
      },
      storage: {
        local: {
          get: async function (defaults) {
            if (options.getFails) throw new Error("storage unavailable");
            var out = {};
            Object.keys(defaults).forEach(function (key) {
              out[key] = key in state ? JSON.parse(JSON.stringify(state[key])) : defaults[key];
            });
            return out;
          },
          set: async function () {}
        },
        onChanged: { addListener: function () {} }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/matcher.js"), "utf8"), context, { filename: "src/matcher.js" });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "popup.js"), "utf8"), context, { filename: "popup.js" });
  return { elements: elements, warnings: warnings, context: context };
}

async function settle() {
  for (var i = 0; i < 10; i += 1) await new Promise(function (resolve) { setImmediate(resolve); });
}

function texts(element) {
  return element.children.map(function (child) { return child.textContent; });
}

// The garbled scalars replaced with plausible values from the same log.
function plausibleRealState() {
  return Object.assign(JSON.parse(JSON.stringify(REAL_STATE)), {
    pingServer: false,
    lastNudgeAt: 1768485389636,
    sessionStartedAt: null,
    lastUserPageLoadAt: 1768480848006
  });
}

test("the popup renders the real stored state, with every section and the log lines", async function () {
  var popup = renderPopup(plausibleRealState());
  await settle();
  var e = popup.elements;
  assert.deepEqual(popup.warnings, []);
  assert.equal(e.status.textContent, "Signed out — log in to eRA again.");
  assert.equal(e["status-block"].classList.contains("tone-bad"), true);
  assert.equal(e["ping-server"].checked, false);
  assert.equal(e.version.textContent, "Version 1.4.3");

  // "Signed in since" has no value while logged out; "Last server check-in"
  // is "Off" because the ping switch is off. Neither ever reads "Never".
  assert.equal(e["dt-signed-in"].hidden, true);
  assert.equal(e["signed-in"].hidden, true);
  assert.equal(e["dt-last-nudge"].hidden, false);
  assert.equal(e["server-checkin"].textContent, "Off");
  assert.equal(e["dt-last-click"].hidden, false);

  var log = texts(e["diagnostic-log"]);
  assert.equal(log.length, 30);
  assert.match(log[0], /status logged-in -> logged-out: login or logout page \(eRA timer cookie deleted\) \(\/assist\/public\/login\.era\)$/);
  assert.match(log[1], /page load \/assist\/public\/login\.era: login or logout page, cookie 45\.0 min$/);
  assert.match(log[2], /nudge \/commonsplus\/home\.era: cookie 41\.0 -> 45\.0 min, server not called \(ping off\)$/);
  // Old v1.2.0 nudges carry serverStatus and no pingServer.
  assert.ok(log.some(function (line) { return /nudge \/commonsplus\/home\.era: cookie 41\.0 -> 45\.0 min, server 204$/.test(line); }), log.join("\n"));

  var cards = e["logout-records"].children;
  assert.equal(cards.length, 3);
  assert.match(cards[0].textContent, /^Ended .* — eRA sent you to its login page/);
  assert.match(cards[0].textContent, /1\.9 min after last activity nudge/);
  assert.match(cards[0].textContent, /77\.6 min after you last loaded a page/);
  assert.match(cards[0].textContent, /eRA timer at last nudge: 45\.0 min/);
  assert.match(cards[0].textContent, /server not called \(ping off\)/);
  assert.match(cards[0].textContent, /eRA deleted its own timeout cookie/);
  assert.match(cards[1].textContent, /^Ended [^—]+$/);
  assert.match(cards[1].textContent, /2\.0 min after last activity nudge/);
  assert.match(cards[1].textContent, /50\.0 min after you last loaded a page/);
  assert.match(cards[2].textContent, /32\.0 min after you last loaded a page/);
  assert.match(cards[2].textContent, /last server ping 4\.0 min earlier/);
  cards.forEach(function (card) { assert.doesNotMatch(card.textContent, /undefined|NaN|null|Never/); });

  await e["copy-log"].listeners.click({ currentTarget: e["copy-log"] });
  assert.equal(popup.context.copied.split("\n").length, REAL_STATE.diagnosticLog.length);
});

test("the popup renders even the garbled scalars without throwing", async function () {
  var popup = renderPopup(REAL_STATE);
  await settle();
  assert.deepEqual(popup.warnings, []);
  assert.equal(texts(popup.elements["diagnostic-log"]).length, 30);
  assert.equal(popup.elements["logout-records"].children.length, 3);
});

test("one bad section or record never blanks the rest of the popup", async function () {
  var state = plausibleRealState();
  state.logoutRecords = [null, "junk", 7, { reason: 5 }].concat(state.logoutRecords);
  state.diagnosticLog = [null, "junk", { type: "status" }, { type: "nudge", at: "x" }].concat(state.diagnosticLog);
  state.sessionStatus = "logged-in";
  var popup = renderPopup(state);
  await settle();
  var e = popup.elements;
  assert.equal(texts(e["diagnostic-log"]).length, 30);
  assert.ok(e["logout-records"].children.length >= 7);
  assert.equal(e.status.textContent, "Keeping you signed in");
  assert.equal(e["status-block"].classList.contains("tone-ok"), true);

  // Not arrays at all: those two parts show their empty text, the rest renders.
  var broken = renderPopup({ logoutRecords: { a: 1 }, diagnosticLog: "oops", sessionStatus: "logged-out" });
  await settle();
  assert.equal(broken.elements["logout-records"].textContent, "No logged-out sessions detected yet.");
  assert.equal(broken.elements["diagnostic-log"].textContent, "No diagnostic entries yet.");
  assert.equal(broken.elements.status.textContent, "Signed out — log in to eRA again.");
});

test("a failing section shows its own message and the others still render", async function () {
  var state = plausibleRealState();
  var popup = renderPopup(state);
  await settle();
  // A formatter that throws stands in for any value the renderer cannot handle.
  var matcher = popup.context.EraKeepAlive;
  var realPopupStatus = matcher.popupStatus;
  matcher.popupStatus = function () { throw new Error("boom"); };
  popup.context.render(state);
  matcher.popupStatus = realPopupStatus;
  assert.match(popup.elements.status.textContent, /^Could not show this part \(boom\)\.$/);
  assert.equal(texts(popup.elements["diagnostic-log"]).length, 30);
  assert.equal(popup.elements["logout-records"].children.length, 3);

  var realFormatTime = matcher.formatTime;
  matcher.formatTime = function () { throw new Error("boom"); };
  popup.context.render(state);
  matcher.formatTime = realFormatTime;
  assert.match(popup.elements.details.textContent, /^Could not show this part \(boom\)\.$/);
  // The status pill does not use formatTime, so it still renders.
  assert.equal(popup.elements.status.textContent, "Signed out — log in to eRA again.");

  // Each record that cannot be read gets its own card; the list stays.
  var realHeadline = matcher.logoutHeadline;
  matcher.logoutHeadline = function () { throw new Error("boom"); };
  popup.elements["logout-records"].textContent = "";
  popup.context.render(state);
  matcher.logoutHeadline = realHeadline;
  var cards = popup.elements["logout-records"].children;
  assert.equal(cards.length, 3);
  cards.forEach(function (card) { assert.equal(card.textContent, "Logged out (this record could not be read)"); });
});

test("the ping switch shows on when nothing is stored, and a failed read still renders", async function () {
  var fresh = renderPopup({});
  await settle();
  assert.equal(fresh.elements["ping-server"].checked, true);
  assert.equal(fresh.elements.enabled.checked, true);

  var failed = renderPopup({}, { getFails: true });
  await settle();
  assert.equal(failed.elements.status.textContent, "Status unknown");
  assert.equal(failed.elements["diagnostic-log"].textContent, "No diagnostic entries yet.");
});

test("the 'open in a tab' link opens popup.html in a tab and does not navigate the popup", async function () {
  var popup = renderPopup(plausibleRealState());
  await settle();
  var prevented = false;
  await popup.elements["open-tab"].listeners.click({ preventDefault: function () { prevented = true; } });
  await settle();
  assert.equal(prevented, true);
  assert.deepEqual(popup.context.tabsCreated, [{ url: "chrome-extension://fake-extension-id/popup.html" }]);
});

test("a server-ended record gets the keep-the-ping-on note in the popup", async function () {
  var popup = renderPopup({
    logoutRecords: [{
      loggedOutDetectedAt: 1768485502113,
      reason: "eRA sent you to its login page while its page timer still had 45 min left — eRA's server ended the session",
      pingServer: false,
      minutesSinceLastNudge: 1.9,
      minutesLeftAtLastNudge: 45
    }]
  });
  await settle();
  var card = popup.elements["logout-records"].children[0];
  assert.match(card.textContent, /eRA's server ended it/);
  assert.match(card.textContent, /Keep "Also ping eRA's server" on\./);
});

test("a server-ended session shows in the status line, with each session's length and eRA's apparent limit", async function () {
  var start = Date.UTC(2026, 8, 25, 17, 50);
  function serverEnd(minutes, dayOffset) {
    var startedAt = start - dayOffset * 86400000;
    return {
      loggedOutDetectedAt: startedAt + (minutes + 0.5) * 60000,
      reason: "eRA's server ended the session (keep-alive refused)",
      serverEnded: true,
      sessionStartedAt: startedAt,
      minutesSinceSignIn: minutes + 0.5,
      estimatedEndAt: startedAt + minutes * 60000,
      firstRefusalAt: startedAt + minutes * 60000,
      lastServerAcceptedAt: startedAt + (minutes - 4) * 60000,
      pingServer: true,
      lastServerPing: "server rejected (redirect)"
    };
  }
  var latest = serverEnd(130, 0);
  var popup = renderPopup({ sessionStatus: "logged-out", serverEndedAt: latest.loggedOutDetectedAt, logoutRecords: [latest, serverEnd(128, 1)] });
  await settle();
  var e = popup.elements;
  var matcher = popup.context.EraKeepAlive;
  assert.deepEqual(popup.warnings, []);
  assert.equal(e.status.textContent, "Signed out — log in to eRA again. " + matcher.serverEndStatus(latest));
  assert.equal(e["status-block"].classList.contains("tone-bad"), true);
  assert.equal(e["session-pattern"].hidden, false);
  assert.equal(e["session-pattern"].textContent, "eRA seems to end sessions about 2 h 9 min after sign-in (seen 2 times).");
  var cards = e["logout-records"].children;
  assert.match(cards[0].textContent, /Session length 2 h 10 min/);
  assert.match(cards[0].textContent, /fixed session limit/);
  assert.match(cards[1].textContent, /Session length 2 h 8 min/);

  // Signed in again: the status line is the normal one; the pattern stays.
  var again = renderPopup({ sessionStatus: "logged-in", logoutRecords: [latest] });
  await settle();
  assert.equal(again.elements.status.textContent, "Keeping you signed in");
  assert.equal(again.elements["status-block"].classList.contains("tone-ok"), true);
  assert.equal(again.elements["session-pattern"].hidden, true);
});

test("the status line names a server end only while that end is the current one", async function () {
  var endedAt = Date.UTC(2026, 8, 25, 20, 0);
  var record = {
    loggedOutDetectedAt: endedAt,
    reason: "eRA's server ended the session (keep-alive refused)",
    serverEnded: true,
    sessionStartedAt: endedAt - 130 * 60000,
    estimatedEndAt: endedAt - 60000
  };
  var matcher = null;
  var current = renderPopup({ sessionStatus: "logged-out", serverEndedAt: endedAt, logoutRecords: [record] });
  await settle();
  matcher = current.context.EraKeepAlive;
  assert.equal(current.elements.status.textContent, "Signed out — log in to eRA again. " + matcher.serverEndStatus(record));

  // Logged out again later without a new record (serverEndedAt cleared by a
  // sign-in in between), or serverEndedAt marking some other end: the old
  // record's time is not shown as current.
  var cleared = renderPopup({ sessionStatus: "logged-out", serverEndedAt: null, logoutRecords: [record] });
  await settle();
  assert.equal(cleared.elements.status.textContent, "Signed out — log in to eRA again.");
  var other = renderPopup({ sessionStatus: "logged-out", serverEndedAt: endedAt + 3600000, logoutRecords: [record] });
  await settle();
  assert.equal(other.elements.status.textContent, "Signed out — log in to eRA again.");

  // The latest record is a different kind of logout.
  var newer = { loggedOutDetectedAt: endedAt + 60000, reason: "eRA timer cookie deleted" };
  var notServer = renderPopup({ sessionStatus: "logged-out", serverEndedAt: endedAt, logoutRecords: [newer, record] });
  await settle();
  assert.equal(notServer.elements.status.textContent, "Signed out — log in to eRA again.");
});

test("the 'eRA will log you out at' clause only appears when there is a future time to show", async function () {
  var at = Date.UTC(2026, 8, 25, 16, 45);
  var withTime = renderPopup({ sessionStatus: "logged-in", eraLogoutAt: at });
  await settle();
  assert.match(withTime.elements.status.textContent, /unless you stay active$/);

  var withoutTime = renderPopup({ sessionStatus: "logged-in", eraLogoutAt: null });
  await settle();
  assert.equal(withoutTime.elements.status.textContent, "Keeping you signed in");
  assert.doesNotMatch(withoutTime.elements.status.textContent, /Never/);
});

test("the server check-in detail row is off, accepted or refused, never a bare 'Never'", async function () {
  var t = Date.UTC(2026, 8, 25, 15, 57);
  var off = renderPopup({ pingServer: false });
  await settle();
  assert.equal(off.elements["server-checkin"].textContent, "Off");

  var accepted = renderPopup({ pingServer: true, lastServerAcceptedAt: t });
  await settle();
  assert.equal(accepted.elements["server-checkin"].textContent, "Accepted at " + accepted.context.EraKeepAlive.clockTime(t));

  var unknown = renderPopup({ pingServer: true });
  await settle();
  assert.equal(unknown.elements["dt-server-checkin"].hidden, true);
  assert.equal(unknown.elements["server-checkin"].hidden, true);
});
