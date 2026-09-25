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

// Just enough DOM for popup.js: elements by id, created elements, text and
// children. Setting textContent replaces the children, as in a browser.
function fakeElement(tag) {
  var element = {
    tagName: tag,
    children: [],
    className: "",
    hidden: false,
    checked: false,
    listeners: {},
    _text: "",
    appendChild: function (child) { element.children.push(child); return child; },
    addEventListener: function (type, fn) { element.listeners[type] = fn; }
  };
  Object.defineProperty(element, "textContent", {
    get: function () { return element._text + element.children.map(function (child) { return child.textContent; }).join(""); },
    set: function (value) { element._text = String(value); element.children = []; }
  });
  return element;
}

function renderPopup(state, options) {
  options = options || {};
  var ids = ["enabled", "ping-server", "status", "signed-in", "last-nudge", "logout-at", "last-click",
    "server-warning", "logout-records", "diagnostic-log", "copy-log", "version"];
  var elements = {};
  ids.forEach(function (id) { elements[id] = fakeElement(id === "logout-records" ? "ul" : "div"); });
  var warnings = [];
  var context = {
    console: { warn: function () { warnings.push(Array.from(arguments)); }, log: function () {}, error: function () {} },
    document: {
      getElementById: function (id) { return elements[id] || null; },
      createElement: fakeElement
    },
    navigator: { clipboard: { writeText: async function (text) { context.copied = text; } } },
    window: { setTimeout: function () {} },
    chrome: {
      runtime: { getManifest: function () { return { version: "1.4.3" }; } },
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
  assert.equal(e.status.textContent, "Enabled — logged out");
  assert.equal(e["ping-server"].checked, false);
  assert.equal(e.version.textContent, "Version 1.4.3");

  var log = texts(e["diagnostic-log"]);
  assert.equal(log.length, 30);
  assert.match(log[0], /status logged-in -> logged-out: login or logout page \(eRA timer cookie deleted\) \(\/assist\/public\/login\.era\)$/);
  assert.match(log[1], /page load \/assist\/public\/login\.era: login or logout page, cookie 45\.0 min$/);
  assert.match(log[2], /nudge \/commonsplus\/home\.era: cookie 41\.0 -> 45\.0 min, server not called \(ping off\)$/);
  // Old v1.2.0 nudges carry serverStatus and no pingServer.
  assert.ok(log.some(function (line) { return /nudge \/commonsplus\/home\.era: cookie 41\.0 -> 45\.0 min, server 204$/.test(line); }), log.join("\n"));

  var records = texts(e["logout-records"]);
  assert.match(records[0], /^Logged out .* \(login or logout page \(eRA timer cookie deleted\)\) — 1\.9 min after last activity nudge; 77\.6 min after you last loaded a page; eRA timer at last nudge: 45\.0 min; server not called \(ping off\)$/);
  assert.match(records[1], /eRA deleted its own timeout cookie/);
  // The v1.2.0 records have no reason, sign-in or ping switch: only what they hold.
  assert.match(records[2], /^Logged out [^(]+ — 2\.0 min after last activity nudge; 50\.0 min after you last loaded a page$/);
  assert.match(records[3], /^Logged out [^(]+ — 32\.0 min after you last loaded a page; last server ping 4\.0 min earlier$/);
  records.forEach(function (line) { assert.doesNotMatch(line, /undefined|NaN|null|Never/); });

  await e["copy-log"].listeners.click({ currentTarget: e["copy-log"] });
  assert.equal(popup.context.copied.split("\n").length, REAL_STATE.diagnosticLog.length);
});

test("the popup renders even the garbled scalars without throwing", async function () {
  var popup = renderPopup(REAL_STATE);
  await settle();
  assert.deepEqual(popup.warnings, []);
  assert.equal(texts(popup.elements["diagnostic-log"]).length, 30);
  assert.equal(texts(popup.elements["logout-records"]).length, 4);
});

test("one bad section or record never blanks the rest of the popup", async function () {
  var state = plausibleRealState();
  state.logoutRecords = [null, "junk", 7, { reason: 5 }].concat(state.logoutRecords);
  state.diagnosticLog = [null, "junk", { type: "status" }, { type: "nudge", at: "x" }].concat(state.diagnosticLog);
  state.serverWarning = "not an object";
  state.sessionStatus = "logged-in";
  var popup = renderPopup(state);
  await settle();
  var e = popup.elements;
  assert.equal(texts(e["diagnostic-log"]).length, 30);
  assert.ok(texts(e["logout-records"]).length >= 8);
  assert.equal(e["server-warning"].hidden, true);
  assert.equal(e.status.textContent, "Enabled — logged in");

  // Not arrays at all: those two parts show their empty text, the rest renders.
  var broken = renderPopup({ logoutRecords: { a: 1 }, diagnosticLog: "oops", sessionStatus: "logged-out" });
  await settle();
  assert.equal(broken.elements["logout-records"].textContent, "No logged-out sessions detected yet.");
  assert.equal(broken.elements["diagnostic-log"].textContent, "No diagnostic entries yet.");
  assert.equal(broken.elements.status.textContent, "Enabled — logged out");
});

test("a failing section shows its own message and the others still render", async function () {
  var state = plausibleRealState();
  var popup = renderPopup(state);
  await settle();
  // A formatter that throws stands in for any value the renderer cannot handle.
  var matcher = popup.context.EraKeepAlive;
  var realFormatTime = matcher.formatTime;
  matcher.formatTime = function () { throw new Error("boom"); };
  popup.elements["logout-records"].textContent = "";
  popup.context.render(state);
  matcher.formatTime = realFormatTime;
  assert.match(popup.elements.status.textContent, /^Could not show this part \(boom\)\.$/);
  assert.equal(texts(popup.elements["diagnostic-log"]).length, 30);
  // Each record that cannot be read gets its own line; the list stays.
  assert.deepEqual(texts(popup.elements["logout-records"]), [
    "Logged out (this record could not be read)",
    "Logged out (this record could not be read)",
    "Logged out (this record could not be read)"
  ]);
});

test("the ping switch shows on when nothing is stored, and a failed read still renders", async function () {
  var fresh = renderPopup({});
  await settle();
  assert.equal(fresh.elements["ping-server"].checked, true);
  assert.equal(fresh.elements.enabled.checked, true);

  var failed = renderPopup({}, { getFails: true });
  await settle();
  assert.equal(failed.elements.status.textContent, "Enabled — status unknown");
  assert.equal(failed.elements["diagnostic-log"].textContent, "No diagnostic entries yet.");
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
  var records = texts(popup.elements["logout-records"]);
  assert.equal(records[1], "eRA's server ended this session even though its page timer was still running. Keep \"Also ping eRA's server\" on.");
});
