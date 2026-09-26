"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

var ROOT = path.join(__dirname, "..");
var matcher_ = require(path.join(ROOT, "src/matcher.js"));
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
  var ids = ["enabled", "ping-server", "status", "status-subtext", "status-block", "details",
    "dt-signed-in", "signed-in", "dt-last-nudge", "last-nudge",
    "dt-server-checkin", "server-checkin", "dt-last-click", "last-click",
    "session-pattern", "logout-records", "diagnostic-log", "copy-log", "version", "open-tab",
    "recorder", "recorder-on", "recorder-count", "download-recording", "clear-recording"];
  var elements = {};
  ids.forEach(function (id) { elements[id] = fakeElement(id === "logout-records" ? "div" : "div"); });
  var warnings = [];
  var tabsCreated = [];
  var calls = { permissionRequests: [], permissionRemovals: [], sets: [], sent: [], downloads: [], blobs: [] };
  var body = fakeElement("body");
  var context = {
    console: { warn: function () { warnings.push(Array.from(arguments)); }, log: function () {}, error: function () {} },
    document: {
      body: body,
      getElementById: function (id) { return elements[id] || null; },
      createElement: function (tag) {
        var created = fakeElement(tag);
        created.click = function () { calls.downloads.push({ href: created.href, download: created.download }); };
        created.remove = function () {};
        return created;
      }
    },
    Blob: function (parts, init) { calls.blobs.push({ text: parts.join(""), type: init && init.type }); this.index = calls.blobs.length - 1; },
    URL: {
      createObjectURL: function (blob) { return "blob:fake/" + blob.index; },
      revokeObjectURL: function () {}
    },
    calls: calls,
    navigator: { clipboard: { writeText: async function (text) { context.copied = text; } } },
    window: { setTimeout: function () {} },
    tabsCreated: tabsCreated,
    chrome: {
      permissions: {
        request: function (perms) {
          calls.permissionRequests.push(JSON.parse(JSON.stringify(perms)));
          if (options.permissionThrows) throw new Error("not a user gesture");
          return Promise.resolve(!!options.grant);
        },
        remove: async function (perms) {
          calls.permissionRemovals.push(JSON.parse(JSON.stringify(perms)));
          if (options.removeRefuses && calls.permissionRemovals.length === 1) throw new Error("You cannot remove required permissions.");
          return true;
        }
      },
      runtime: {
        sendMessage: async function (message) { calls.sent.push(message); return { ok: true }; },
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
            if (defaults === null) return JSON.parse(JSON.stringify(state));
            if (typeof defaults === "string") defaults = [defaults];
            if (Array.isArray(defaults)) {
              defaults.forEach(function (key) { if (key in state) out[key] = JSON.parse(JSON.stringify(state[key])); });
              return out;
            }
            Object.keys(defaults).forEach(function (key) {
              out[key] = key in state ? JSON.parse(JSON.stringify(state[key])) : defaults[key];
            });
            return out;
          },
          set: async function (values) {
            calls.sets.push(JSON.parse(JSON.stringify(values)));
            Object.assign(state, JSON.parse(JSON.stringify(values)));
          }
        },
        onChanged: { addListener: function () {} }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/matcher.js"), "utf8"), context, { filename: "src/matcher.js" });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/recorder.js"), "utf8"), context, { filename: "src/recorder.js" });
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
  assert.equal(e.status.textContent, "Keeping you signed in — last check-in " + matcher_.clockTime(state.lastNudgeAt));
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

test("the 'last check-in' clause only appears when there has been a nudge", async function () {
  var at = Date.UTC(2026, 8, 25, 16, 45);
  var withNudge = renderPopup({ sessionStatus: "logged-in", lastNudgeAt: at });
  await settle();
  assert.equal(withNudge.elements.status.textContent, "Keeping you signed in — last check-in " + withNudge.context.EraKeepAlive.clockTime(at));

  var withoutNudge = renderPopup({ sessionStatus: "logged-in", lastNudgeAt: null });
  await settle();
  assert.equal(withoutNudge.elements.status.textContent, "Keeping you signed in");
  assert.doesNotMatch(withoutNudge.elements.status.textContent, /Never/);
});

test("a server-end pattern sentence shows as a muted line under the green status", async function () {
  var start = Date.UTC(2026, 8, 25, 17, 50);
  function serverEnd(minutes, dayOffset) {
    var startedAt = start - dayOffset * 86400000;
    return {
      loggedOutDetectedAt: startedAt + minutes * 60000,
      reason: matcher_.SERVER_END_REASON,
      serverEnded: true,
      sessionStartedAt: startedAt,
      estimatedEndAt: startedAt + minutes * 60000
    };
  }
  var withPattern = renderPopup({
    sessionStatus: "logged-in",
    lastNudgeAt: start,
    logoutRecords: [serverEnd(128, 0), serverEnd(132, 1)]
  });
  await settle();
  assert.equal(withPattern.elements["status-block"].classList.contains("tone-ok"), true);
  assert.equal(withPattern.elements["status-subtext"].hidden, false);
  assert.equal(withPattern.elements["status-subtext"].textContent,
    "eRA seems to end sessions about 2 h 10 min after sign-in (seen 2 times).");
  // The standalone pattern line stays hidden while signed in — the same
  // sentence is already the status subtext, so it is not said twice.
  assert.equal(withPattern.elements["session-pattern"].hidden, true);

  // No pattern yet (fewer than two server-ended records): the line stays hidden.
  var withoutPattern = renderPopup({ sessionStatus: "logged-in", lastNudgeAt: start, logoutRecords: [serverEnd(128, 0)] });
  await settle();
  assert.equal(withoutPattern.elements["status-subtext"].hidden, true);
  assert.equal(withoutPattern.elements["status-subtext"].textContent, "");
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

test("the recorder switch asks for exactly the optional permissions, straight from the click; a refusal leaves it off", async function () {
  var popup = renderPopup({ recorderOn: false }, { grant: false });
  await settle();
  var sw = popup.elements["recorder-on"];
  assert.equal(sw.checked, false);
  sw.checked = true;
  var done = sw.listeners.change();
  // Asked synchronously, inside the click, before any await.
  assert.equal(popup.context.calls.permissionRequests.length, 1);
  assert.deepEqual(popup.context.calls.permissionRequests[0], {
    permissions: ["webRequest"], origins: ["https://*.nih.gov/*", "https://*.login.gov/*"]
  });
  assert.equal(sw.checked, false);
  await done;
  assert.equal(sw.checked, false);
  var last = popup.context.calls.sets[popup.context.calls.sets.length - 1];
  assert.equal(last.recorderOn, false);

  var throws = renderPopup({ recorderOn: false }, { permissionThrows: true });
  await settle();
  throws.elements["recorder-on"].checked = true;
  await throws.elements["recorder-on"].listeners.change();
  assert.equal(throws.elements["recorder-on"].checked, false);
});

test("a granted request turns the recorder on; turning it off keeps the recording and gives the permissions back", async function () {
  var state = { recorderOn: false };
  var popup = renderPopup(state, { grant: true, removeRefuses: true });
  await settle();
  var sw = popup.elements["recorder-on"];
  sw.checked = true;
  await sw.listeners.change();
  assert.equal(sw.checked, true);
  assert.equal(state.recorderOn, true);

  state.recording = { count: 2, next: 1, chunks: [{ id: 0, n: 2 }] };
  state["recording-0"] = [{ t: 1, event: "request" }, { t: 2, event: "completed" }];
  sw.checked = false;
  await sw.listeners.change();
  assert.equal(state.recorderOn, false);
  assert.ok(state.recording, "turning it off must not clear the recording");
  // The first, full removal was refused (it overlaps the required eRA site
  // access on some Chrome versions); a smaller one followed.
  var removals = popup.context.calls.permissionRemovals;
  assert.equal(removals.length, 2);
  assert.deepEqual(removals[1].permissions, ["webRequest"]);
});

test("the popup shows the event count and downloads the recording as a JSON file; Clear asks the background", async function () {
  var state = {
    recorderOn: true,
    recording: { count: 2, next: 1, chunks: [{ id: 0, n: 2 }] },
    "recording-0": [{ t: 1, event: "request", host: "public.era.nih.gov", path: "/a" }, { t: 2, event: "completed" }],
    recorderSalt: "do-not-export"
  };
  var popup = renderPopup(state);
  await settle();
  var e = popup.elements;
  assert.equal(e["recorder-count"].textContent, "2 events recorded");
  assert.equal(e["recorder-on"].checked, true);
  assert.equal(e["download-recording"].disabled, false);

  await e["download-recording"].listeners.click({ currentTarget: e["download-recording"] });
  var calls = popup.context.calls;
  assert.equal(calls.downloads.length, 1);
  assert.match(calls.downloads[0].download, /^era-recording-\d{8}-\d{4}\.json$/);
  assert.equal(calls.downloads[0].href, "blob:fake/0");
  assert.equal(calls.blobs[0].type, "application/json");
  var file = JSON.parse(calls.blobs[0].text);
  assert.equal(file.count, 2);
  assert.equal(file.events[0].path, "/a");
  assert.equal(calls.blobs[0].text.indexOf("do-not-export"), -1);

  await e["clear-recording"].listeners.click({ currentTarget: e["clear-recording"] });
  assert.deepEqual(calls.sent.map(function (m) { return m.type; }), ["recorder-clear"]);
  assert.equal(e["clear-recording"].textContent, "Cleared");

  var empty = renderPopup({});
  await settle();
  assert.equal(empty.elements["recorder-count"].textContent, "No events recorded.");
  assert.equal(empty.elements["recorder-on"].checked, false);
  assert.equal(empty.elements["download-recording"].disabled, true);
});
