"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var matcher = require("../src/matcher.js");

function node(text, selectors, options) {
  options = options || {};
  return {
    innerText: text,
    id: options.id || "",
    visibility: options.visibility || { clientRectCount: 1, display: "block", visibility: "visible" },
    getAttribute: function (name) { return name === "id" ? this.id : null; },
    querySelector: function (selector) { return selectors && selectors[selector] || null; },
    querySelectorAll: function (selector) { return selectors && selectors[selector] || []; }
  };
}

function visible(nodeLike) {
  return matcher.isVisible(nodeLike.visibility);
}

var REGION = '[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"], [role="alert"]';
var CONTROLS = 'button, input[type="button"], input[type="submit"], [role="button"]';

test("finds a continue button in a timeout dialog", function () {
  var continueButton = node("Stay signed in");
  var dialog = node("Your session will expire because of inactivity.", { [CONTROLS]: [continueButton] });
  var documentLike = node("", { [REGION]: [dialog] });
  assert.equal(matcher.findTimeoutContinueButton(documentLike, visible), continueButton);
});

test("ignores a continue button in an unrelated dialog", function () {
  var continueButton = node("Continue");
  var dialog = node("Continue editing your application.", { [CONTROLS]: [continueButton] });
  var documentLike = node("", { [REGION]: [dialog] });
  assert.equal(matcher.findTimeoutContinueButton(documentLike, visible), null);
});

test("never selects logout or sign-out actions in a timeout dialog", function () {
  var logout = node("Log out");
  var signout = node("Sign out");
  var dialog = node("Your session timeout is approaching.", { [CONTROLS]: [logout, signout] });
  var documentLike = node("", { [REGION]: [dialog] });
  assert.equal(matcher.findTimeoutContinueButton(documentLike, visible), null);
  assert.equal(matcher.isContinueButtonText("Sign out"), false);
});

test("recognizes only the explicit login and logout URLs", function () {
  assert.equal(matcher.isLoginUrl("https://www.era.nih.gov/erahelp/commons/commons/access/login.htm"), false);
  assert.equal(matcher.isLoginUrl("https://public.era.nih.gov/commonsplus/public/login.era"), true);
  assert.equal(matcher.isLoginUrl("https://secure.login.gov/"), true);
  assert.equal(matcher.isLoginUrl("https://public.era.nih.gov/commons/authi/public/do?action=logout"), true);
  assert.equal(matcher.isLoginUrl("https://public.era.nih.gov/commonsplus/home.era"), false);
});

test("does not select a continue button in a hidden timeout modal", function () {
  var continueButton = node("Continue", null, { id: "extendSessionBtn" });
  var hiddenDialog = node("Your session will expire because of inactivity.", {
    "#extendSessionBtn": continueButton
  }, {
    id: "sessionTimeoutModalDialog",
    visibility: { clientRectCount: 0, display: "none", visibility: "hidden" }
  });
  var documentLike = node("", { "#sessionTimeoutModalDialog": hiddenDialog });
  assert.equal(matcher.findTimeoutContinueButton(documentLike, visible), null);
});

test("prefers the known visible Bootstrap continue button", function () {
  var continueButton = node("Continue", null, { id: "extendSessionBtn" });
  var dialog = node("Your session will expire because of inactivity.", {
    "#extendSessionBtn": continueButton,
    [CONTROLS]: [continueButton]
  }, { id: "sessionTimeoutModalDialog" });
  var documentLike = node("", {
    "#sessionTimeoutModalDialog": dialog,
    [REGION]: [dialog]
  });
  assert.equal(matcher.findTimeoutContinueButton(documentLike, visible), continueButton);
});

test("never chooses known logout buttons", function () {
  var logoutButton = node("Continue", null, { id: "logoutBtn" });
  var dialog = node("Your session will expire because of inactivity.", {
    "#logoutBtn": logoutButton,
    [CONTROLS]: [logoutButton]
  }, { id: "sessionTimeoutModalDialog" });
  var documentLike = node("", {
    "#sessionTimeoutModalDialog": dialog,
    [REGION]: [dialog]
  });
  assert.equal(matcher.findTimeoutContinueButton(documentLike, visible), null);
});

test("parses the eRA timeout cookie among other cookies", function () {
  assert.equal(
    matcher.parseEraLogoutAt("theme=dark; ERA_SESSION_TIMEOUT_COOKIE=1760000000000; locale=en-US"),
    1760000000000
  );
  assert.equal(matcher.parseEraLogoutAt("theme=dark; locale=en-US"), null);
});

test("recognizes eRA's explicit logout URL", function () {
  assert.equal(matcher.isEraLogoutUrl("https://public.era.nih.gov/commons/authi/public/do?action=logout"), true);
  assert.equal(matcher.isEraLogoutUrl("https://public.era.nih.gov/commons/authi/public/do?action=continue"), false);
});

test("builds eRA's keep-session-alive URL and rejects other origins", function () {
  assert.equal(
    matcher.buildKeepSessionAliveUrl(
      "https://public.era.nih.gov",
      "/commonsplus",
      "https://public.era.nih.gov/commonsplus/home.era"
    ),
    "https://public.era.nih.gov/commonsplus/jsp/keepSessionAlive.jsp"
  );
  assert.equal(
    matcher.buildKeepSessionAliveUrl("", "/commonsplus", "https://public.era.nih.gov/commonsplus/home.era"),
    "https://public.era.nih.gov/commonsplus/jsp/keepSessionAlive.jsp"
  );
  assert.equal(
    matcher.buildKeepSessionAliveUrl("", "commonsplus", "https://public.era.nih.gov/commonsplus/home.era"),
    "https://public.era.nih.gov/commonsplus/jsp/keepSessionAlive.jsp"
  );
  assert.equal(
    matcher.buildKeepSessionAliveUrl("/", "commonsplus", "https://public.era.nih.gov/commonsplus/home.era"),
    "https://public.era.nih.gov/commonsplus/jsp/keepSessionAlive.jsp"
  );
  assert.equal(
    matcher.buildKeepSessionAliveUrl("https://example.com/", "commonsplus", "https://public.era.nih.gov/home"),
    null
  );
});

test("classifies each tab result as active, ended or neutral", function () {
  var live = { managerPresent: true, minsLeftBefore: 41 };
  assert.equal(matcher.classifyTabResult(live, "unknown"), "active");
  assert.equal(matcher.classifyTabResult({ ...live, ignored: true }, "logged-in"), "neutral");
  assert.equal(matcher.classifyTabResult({ unreachable: true, isLoginPage: false }, "logged-in"), "neutral");
  // An unreachable tab is still judged by its URL.
  assert.equal(matcher.classifyTabResult({ unreachable: true, isLoginPage: true }, "logged-in"), "ended");
  assert.equal(matcher.classifyTabResult({ ...live, disabled: true }, "logged-in"), "neutral");
  assert.equal(matcher.classifyTabResult({ isLoginPage: true }, "unknown"), "ended");
  // A rejected keep-alive does not end a session whose timer is live...
  assert.equal(matcher.classifyTabResult({ ...live, serverRedirectedToLogin: true }, "unknown"), "active");
  assert.equal(matcher.classifyTabResult({ ...live, serverRejected: true }, "logged-in"), "active");
  // ...only one whose cookie is gone too.
  assert.equal(matcher.classifyTabResult({ managerPresent: true, minsLeftBefore: null, serverRejected: true }, "unknown"), "ended");
  // A missing or expired cookie ends the session only after it was seen live.
  assert.equal(matcher.classifyTabResult({ managerPresent: true, minsLeftBefore: null }, "logged-in"), "ended");
  assert.equal(matcher.classifyTabResult({ managerPresent: false, minsLeftBefore: -2 }, "logged-in"), "ended");
  assert.equal(matcher.classifyTabResult({ managerPresent: true, minsLeftBefore: null }, "unknown"), "neutral");
  assert.equal(matcher.classifyTabResult({ managerPresent: true, minsLeftBefore: null }, "logged-out"), "neutral");
  // A live cookie on a page without eRA's timer says nothing either way.
  assert.equal(matcher.classifyTabResult({ managerPresent: false, minsLeftBefore: 30 }, "logged-in"), "neutral");
  assert.equal(matcher.explainTabResult({ managerPresent: true, minsLeftBefore: null }, "logged-in").reason, "cookie deleted");
});

test("derives session status across all relevant tab results", function () {
  var active = { managerPresent: true, minsLeftBefore: 41, minsLeftAfter: 45 };
  var expired = { managerPresent: true, minsLeftBefore: -1, minsLeftAfter: -1 };
  var login = { managerPresent: false, minsLeftBefore: null, isLoginPage: true };
  var neutral = { managerPresent: false, minsLeftBefore: null };
  assert.equal(matcher.deriveSessionStatus([expired, active], "logged-in"), "logged-in");
  assert.equal(matcher.deriveSessionStatus([expired, login], "unknown"), "logged-out");
  assert.equal(matcher.deriveSessionStatus([{ unreachable: true }, login], "logged-in"), "logged-out");
  assert.equal(matcher.deriveSessionStatus([{ ...active, serverRejected: true }], "logged-in"), "logged-in");
  assert.equal(matcher.deriveSessionStatus([expired], "logged-in"), "logged-out");
  assert.equal(matcher.deriveSessionStatus([expired], "unknown"), "unknown");
  assert.equal(matcher.deriveSessionStatus([neutral, { unreachable: true }], "logged-in"), "logged-out");
  // Neutral-only evidence never changes the status.
  assert.equal(matcher.deriveSessionStatus([{ unreachable: true }], "logged-in"), "logged-in");
  assert.equal(matcher.deriveSessionStatus([{ unreachable: true }], "logged-out"), "logged-out");
  assert.equal(matcher.deriveSessionStatus([{ managerPresent: false, minsLeftBefore: 30 }], "logged-in"), "logged-in");
  assert.equal(matcher.deriveSessionStatus([], "logged-in"), "logged-in");
  assert.equal(matcher.deriveSessionStatus([{ ...active, ignored: true }], "logged-out"), "logged-out");
  assert.equal(matcher.deriveSessionStatus([]), "unknown");
});

test("strips ;jsessionid path parameters from paths and login checks", function () {
  assert.equal(
    matcher.safePath("https://public.era.nih.gov/commons;jsessionid=ABC/home.era;x=1?secret=1#frag"),
    "/commons/home.era"
  );
  assert.equal(matcher.safePath("/commonsplus/home.era;jsessionid=ABC?secret=value"), "/commonsplus/home.era");
  assert.equal(matcher.isLoginUrl("https://public.era.nih.gov/commonsplus/public/login.era;jsessionid=ABC"), true);
  assert.equal(matcher.isLoginUrl("https://public.era.nih.gov/commons/public/login.jsp"), true);
  assert.equal(matcher.isLoginUrl("https://public.era.nih.gov/commons/public/login.do;jsessionid=1?x=y"), true);
  assert.equal(matcher.isLoginUrl("https://public.era.nih.gov/commons/public/login.docs"), false);
  assert.equal(
    matcher.isLoginUrl("https://public.era.nih.gov/commons/authi/public/do;jsessionid=ABC?action=logout"),
    true
  );
});

function logAt(fields) {
  return matcher.formatLogLine(Object.assign({ at: new Date(2026, 0, 1, 10, 4).getTime(), path: "/commonsplus/home.era" }, fields));
}

test("formats a nudge log line without query strings", function () {
  var line = logAt({
    type: "nudge",
    path: "/commonsplus/home.era;jsessionid=ABC?secret=value",
    managerPresent: true,
    minsLeftBefore: 41.24,
    minsLeftAfter: 44.96,
    pingServer: true,
    serverCalled: true,
    serverStatus: 200
  });
  assert.equal(line, "10:04 nudge /commonsplus/home.era: cookie 41.2 -> 45.0 min, server 200");
  assert.equal(line.includes("secret"), false);
  assert.equal(line.includes("jsessionid"), false);
});

test("log lines always show the cookie state and the server outcome", function () {
  assert.equal(
    logAt({ type: "nudge", managerPresent: false, minsLeftBefore: null, pingServer: false }),
    "10:04 nudge /commonsplus/home.era: no timeout manager, cookie deleted, server not called (ping off)"
  );
  assert.equal(
    logAt({ type: "nudge", managerPresent: false, minsLeftBefore: 12.34, pingServer: true }),
    "10:04 nudge /commonsplus/home.era: no timeout manager, cookie 12.3 min, server not called"
  );
  assert.equal(
    logAt({ type: "nudge", managerPresent: true, minsLeftBefore: -1.02, pingServer: true }),
    "10:04 nudge /commonsplus/home.era: cookie -1.0 min (expired), server not called"
  );
  assert.equal(
    logAt({ type: "nudge", managerPresent: true, minsLeftBefore: 30, minsLeftAfter: 45, pingServer: true, serverCalled: true, serverError: true }),
    "10:04 nudge /commonsplus/home.era: cookie 30.0 -> 45.0 min, server error"
  );
  assert.equal(
    logAt({ type: "nudge", managerPresent: true, minsLeftBefore: 30, minsLeftAfter: 45, pingServer: true, serverCalled: true, serverRejected: true }),
    "10:04 nudge /commonsplus/home.era: cookie 30.0 -> 45.0 min, server rejected (redirect)"
  );
  assert.equal(
    logAt({ type: "nudge", unreachable: true }),
    "10:04 nudge /commonsplus/home.era: could not reach tab (reload it)"
  );
  assert.equal(
    logAt({ type: "page-load", managerPresent: true, minsLeft: 44.96 }),
    "10:04 page load /commonsplus/home.era: cookie 45.0 min"
  );
  assert.equal(
    logAt({ type: "page-load", managerPresent: false, minsLeft: null }),
    "10:04 page load /commonsplus/home.era: no timeout manager, cookie deleted"
  );
  assert.equal(logAt({ type: "no-tabs", from: "logged-in" }), "10:04 no eRA tabs open (status logged-in -> unknown)");
  assert.equal(logAt({ type: "alarm-late", minutesLate: 93.25 }), "10:04 alarm late by 93.3 min (computer asleep?)");
});

test("formats minutes to one decimal", function () {
  assert.equal(matcher.formatMinutes(12.345), "12.3 min");
  assert.equal(matcher.formatMinutes(null), null);
  assert.equal(matcher.roundMinutes(44.96), 45);
  assert.equal(matcher.formatTime(null), "Never");
});

test("identifies pages excluded from status and page-load tracking", function () {
  assert.equal(matcher.isIgnoredEraUrl("https://www.era.nih.gov/news"), true);
  assert.equal(matcher.isIgnoredEraUrl("https://public.era.nih.gov/erahelp/commons/index.htm"), true);
  assert.equal(matcher.isIgnoredEraUrl("https://public.era.nih.gov/commonsplus/home.era"), false);
});

test("cookie change events: overwrite ignored, deletion and expiry end, a future value is live", function () {
  var now = 1000000;
  var cookie = { name: "ERA_SESSION_TIMEOUT_COOKIE", domain: ".era.nih.gov", value: String(now + 60000) };
  assert.deepEqual(matcher.classifyCookieChange({ removed: true, cause: "overwrite", cookie: cookie }, now), { kind: "ignore" });
  assert.equal(matcher.classifyCookieChange({ removed: true, cause: "explicit", cookie: cookie }, now).reason, "eRA timer cookie deleted");
  assert.equal(matcher.classifyCookieChange({ removed: true, cause: "expired_overwrite", cookie: cookie }, now).kind, "ended");
  assert.equal(matcher.classifyCookieChange({ removed: true, cause: "expired", cookie: cookie }, now).reason, "eRA timer cookie expired");
  assert.equal(matcher.classifyCookieChange({ removed: true, cause: "evicted", cookie: cookie }, now).kind, "ignore");
  assert.deepEqual(matcher.classifyCookieChange({ removed: false, cause: "explicit", cookie: cookie }, now), { kind: "live", logoutAt: now + 60000 });
  assert.equal(matcher.classifyCookieChange({ removed: false, cookie: { ...cookie, value: String(now - 1) } }, now).kind, "ignore");
  assert.equal(matcher.classifyCookieChange({ removed: false, cookie: { ...cookie, value: "" } }, now).kind, "ignore");
  assert.equal(matcher.classifyCookieChange({ removed: true, cause: "explicit", cookie: { ...cookie, domain: ".example.com" } }, now).kind, "ignore");
  assert.equal(matcher.classifyCookieChange({ removed: true, cause: "explicit", cookie: { ...cookie, name: "other" } }, now).kind, "ignore");
  assert.equal(matcher.isEraTimeoutCookie({ ...cookie, domain: "public.era.nih.gov" }), true);
  assert.equal(matcher.isEraTimeoutCookie({ ...cookie, domain: "era.nih.gov.evil.com" }), false);
});

test("summarizes the cookies Chrome holds: live, expired or missing", function () {
  var now = 1000000;
  function era(value) { return { name: "ERA_SESSION_TIMEOUT_COOKIE", domain: ".era.nih.gov", value: String(value) }; }
  assert.deepEqual(matcher.summarizeEraCookies([], now), { state: "missing", logoutAt: null, minsLeft: null });
  assert.equal(matcher.summarizeEraCookies([era("")], now).state, "missing");
  assert.equal(matcher.summarizeEraCookies([era(now - 60000)], now).state, "expired");
  var live = matcher.summarizeEraCookies([era(now - 60000), era(now + 120000)], now);
  assert.equal(live.state, "live");
  assert.equal(live.logoutAt, now + 120000);
  assert.equal(live.minsLeft, 2);
});

test("decides the session from tabs and the cookie, preferring positive evidence", function () {
  var active = { managerPresent: true, minsLeftBefore: 41, path: "/a" };
  var login = { isLoginPage: true, path: "/login" };
  var noCookieTab = { managerPresent: true, minsLeftBefore: null, path: "/b" };
  var live = { state: "live" };
  var missing = { state: "missing" };
  assert.deepEqual(matcher.decideSession([active, login], "logged-in", missing), { status: "logged-in", reason: "live eRA timer", path: "/a" });
  // A live cookie outranks a login page; without one the login page ends it.
  assert.equal(matcher.decideSession([login], "logged-in", live).status, "logged-in");
  assert.deepEqual(matcher.decideSession([login], "logged-in", missing),
    { status: "logged-out", reason: "login or logout page (eRA timer cookie deleted)", path: "/login" });
  assert.equal(matcher.decideSession([login], "logged-in", null).reason, "login or logout page");
  // The login page itself still saw eRA's timer running: eRA's server ended it,
  // whatever Chrome's cookie read says afterwards.
  var liveLogin = { isLoginPage: true, minsLeftBefore: 45, path: "/assist/public/login.era" };
  var serverEnded = "eRA sent you to its login page while its page timer still had 45 min left — eRA's server ended the session";
  assert.deepEqual(matcher.decideSession([liveLogin], "logged-in", missing), { status: "logged-out", reason: serverEnded, path: "/assist/public/login.era" });
  assert.equal(matcher.decideSession([liveLogin], "logged-in", null).reason, serverEnded);
  assert.equal(matcher.decideSession([Object.assign({}, liveLogin, { minsLeftBefore: 12.34 })], "logged-in", missing).reason,
    "eRA sent you to its login page while its page timer still had 12.3 min left — eRA's server ended the session");
  assert.equal(matcher.decideSession([liveLogin], "logged-in", live).status, "logged-in");
  // Only a missing or expired timer on the login page says "cookie deleted"/"expired".
  assert.equal(matcher.decideSession([Object.assign({}, liveLogin, { minsLeftBefore: null })], "logged-in", missing).reason,
    "login or logout page (eRA timer cookie deleted)");
  assert.equal(matcher.decideSession([Object.assign({}, liveLogin, { minsLeftBefore: -2 })], "logged-in", { state: "expired" }).reason,
    "login or logout page (eRA timer cookie expired)");
  // A tab that saw no cookie is overruled by a live cookie read from Chrome.
  assert.equal(matcher.decideSession([noCookieTab], "logged-in", live).status, "logged-in");
  assert.equal(matcher.decideSession([noCookieTab], "logged-in", null).reason, "cookie deleted");
  assert.deepEqual(matcher.decideSession([{ unreachable: true }], "logged-in", missing),
    { status: "logged-out", reason: "eRA timer cookie deleted", path: null });
  assert.equal(matcher.decideSession([{ unreachable: true }], "logged-in", { state: "expired" }).reason, "eRA timer cookie expired");
  assert.equal(matcher.decideSession([{ unreachable: true }], "logged-in", null).status, "logged-in");
  assert.equal(matcher.decideSession([], "unknown", live).status, "logged-in");
  // A cookie that is merely still there does not undo a logout.
  assert.equal(matcher.decideSession([], "logged-out", live).status, "logged-out");
  assert.equal(matcher.decideSession([], "unknown", missing).status, "unknown");
});

test("the popup's logout note names what ended the session", function () {
  var stillLive = "eRA's own timer still had time left — something else ended the session (server or a hard limit).";
  assert.equal(matcher.logoutNote({ reason: "login or logout page", minutesSinceLastNudge: 3, minutesLeftAtLastNudge: 45 }), stillLive);
  assert.equal(matcher.logoutNote({ reason: "login or logout page", minutesSinceLastNudge: 50, minutesLeftAtLastNudge: 45 }), null);
  assert.equal(matcher.logoutNote({ reason: "login or logout page", minutesSinceLastNudge: null, minutesLeftAtLastNudge: 45 }), null);
  assert.match(matcher.logoutNote({ reason: "eRA timer cookie deleted", minutesSinceLastNudge: 3, minutesLeftAtLastNudge: 45 }),
    /page timer or the Logout button/);
  assert.match(matcher.logoutNote({ reason: "cookie deleted", minutesSinceLastNudge: 3, minutesLeftAtLastNudge: 45 }),
    /page timer or the Logout button/);
  assert.match(matcher.logoutNote({ reason: "eRA timer cookie expired" }), /timer ran out/);
  assert.match(matcher.logoutNote({ reason: "ended while no eRA tab was open", estimatedEndAt: 1, minutesSinceLastNudge: 3, minutesLeftAtLastNudge: 45 }),
    /No eRA tab was open/);
  assert.equal(matcher.logoutNote(null), null);
  assert.equal(matcher.logoutNote({
    reason: "eRA sent you to its login page while its page timer still had 45 min left — eRA's server ended the session",
    minutesSinceLastNudge: 1.9, minutesLeftAtLastNudge: 45
  }), "eRA's server ended this session even though its page timer was still running. Keep \"Also ping eRA's server\" on.");
});

test("compares extension versions", function () {
  assert.equal(matcher.isVersionBefore("1.4.2", "1.4.3"), true);
  assert.equal(matcher.isVersionBefore("1.2.0", "1.4.3"), true);
  assert.equal(matcher.isVersionBefore("1.4.3", "1.4.3"), false);
  assert.equal(matcher.isVersionBefore("1.4.10", "1.4.3"), false);
  assert.equal(matcher.isVersionBefore("2.0", "1.4.3"), false);
  assert.equal(matcher.isVersionBefore(undefined, "1.4.3"), true);
});

test("a Logout noticed during a tick never gets the server or hard-limit note", function () {
  var loginTab = { isLoginPage: true, path: "/commons/authi/public/do" };
  var deletedTab = { managerPresent: true, minsLeftBefore: null, path: "/commons/home" };
  var cases = [
    matcher.decideSession([loginTab], "logged-in", { state: "missing" }),
    matcher.decideSession([loginTab], "logged-in", { state: "expired" }),
    matcher.decideSession([deletedTab], "logged-in", null),
    matcher.decideSession([], "logged-in", { state: "missing" }),
    matcher.decideSession([], "logged-in", { state: "expired" })
  ];
  cases.forEach(function (decision) {
    assert.equal(decision.status, "logged-out");
    var note = matcher.logoutNote({ reason: decision.reason, minutesSinceLastNudge: 1, minutesLeftAtLastNudge: 44 });
    assert.ok(note && !/hard limit/.test(note), decision.reason + ": " + note);
  });
});

test("formats server timeouts, server warnings and the no-tabs cookie state", function () {
  assert.equal(matcher.describeServer({ serverCalled: true, serverTimeout: true }), "server timeout");
  assert.equal(
    logAt({ type: "server-warning" }),
    "10:04 server rejected keep-alive (redirect) /commonsplus/home.era; eRA timer still live, still nudging"
  );
  assert.equal(
    logAt({ type: "no-tabs", from: "logged-in", to: "logged-in", cookie: "live", minsLeft: 30 }),
    "10:04 no eRA tabs open, cookie 30.0 min; still logged in, nothing to nudge (4-minute timer stopped)"
  );
  assert.equal(logAt({ type: "no-tabs", from: "logged-in", to: "logged-out", cookie: "missing", minsLeft: null }), "10:04 no eRA tabs open, cookie deleted");
  assert.equal(
    logAt({ type: "no-tabs", from: "logged-in", to: "idle", cookie: "live", minsLeft: 30 }),
    "10:04 no eRA tabs open, cookie 30.0 min; not keeping the session alive until an eRA tab is open (4-minute timer stopped)"
  );
  assert.equal(logAt({ type: "no-tabs", from: "logged-in", to: "logged-in", cookie: null }), "10:04 no eRA tabs open, cookie unreadable; still logged in, nothing to nudge (4-minute timer stopped)");
});

test("formats session lengths and names eRA's apparent session limit", function () {
  assert.equal(matcher.formatDuration(130.4), "2 h 10 min");
  assert.equal(matcher.formatDuration(45), "45 min");
  assert.equal(matcher.formatDuration(120), "2 h");
  assert.equal(matcher.formatDuration(null), null);

  var start = Date.UTC(2026, 8, 25, 17, 50);
  var server = function (minutes) {
    return { reason: matcher.SERVER_END_REASON, serverEnded: true, sessionStartedAt: start, estimatedEndAt: start + minutes * 60000 };
  };
  assert.equal(matcher.sessionLengthMinutes(server(131)), 131);
  assert.equal(matcher.sessionLengthMinutes({ minutesSinceSignIn: 50 }), 50);

  // One server end is not a pattern; other kinds of logout never count.
  assert.equal(matcher.sessionEndPattern([server(130)]), null);
  assert.equal(matcher.sessionEndPattern([server(130), { reason: "cookie deleted", minutesSinceSignIn: 131 }]), null);
  // Two more than 15 minutes apart are not one either.
  assert.equal(matcher.sessionEndPattern([server(100), server(130)]), null);
  assert.equal(matcher.sessionEndPattern([server(128), server(132)]),
    "eRA seems to end sessions about 2 h 10 min after sign-in (seen 2 times).");
  // Records that hold only minutesSinceSignIn work too; the biggest group wins.
  assert.equal(matcher.sessionEndPattern([
    { reason: matcher.SERVER_END_REASON, minutesSinceSignIn: 60 },
    server(129), server(131), server(130),
    { reason: matcher.SERVER_END_REASON, minutesSinceSignIn: 62 }
  ]), "eRA seems to end sessions about 2 h 10 min after sign-in (seen 3 times).");
  assert.equal(matcher.sessionEndPattern("junk"), null);

  var record = server(130);
  assert.equal(matcher.serverEndStatus(record), "eRA's server ended your session at " +
    matcher.clockTime(record.estimatedEndAt) + " — 2 h 10 min after sign-in. Log in again.");
  assert.match(matcher.logoutNote(record), /fixed session limit/);
  assert.equal(matcher.serverEndNotification(record.estimatedEndAt, null).message,
    "eRA's server stopped accepting your session around " + matcher.clockTime(record.estimatedEndAt) + ".");
  assert.match(matcher.formatLogLine({ type: "server-refused", at: start, path: "/commonsplus/home.era" }),
    /server refused keep-alive — rechecking in 30 s \(\/commonsplus\/home\.era\)$/);
  assert.match(matcher.formatLogLine({ type: "server-recheck-retry", at: start, retry: 2, of: 3 }),
    /server recheck: no eRA tab to ping — trying again in 30 s \(2 of 3\)$/);
  assert.match(matcher.formatLogLine({ type: "server-recheck-deferred", at: start }),
    /server recheck: still no eRA tab to ping — the next regular check will ask eRA's server$/);
});
