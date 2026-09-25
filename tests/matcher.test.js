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
  assert.equal(matcher.classifyTabResult({ isLoginPage: true }, "unknown"), "ended");
  assert.equal(matcher.classifyTabResult({ ...live, serverRedirectedToLogin: true }, "unknown"), "ended");
  assert.equal(matcher.classifyTabResult({ ...live, serverRejected: true }, "unknown"), "ended");
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
  assert.equal(matcher.deriveSessionStatus([{ ...active, serverRejected: true }], "logged-in"), "logged-out");
  assert.equal(matcher.deriveSessionStatus([expired], "logged-in"), "logged-out");
  assert.equal(matcher.deriveSessionStatus([expired], "unknown"), "unknown");
  assert.equal(matcher.deriveSessionStatus([neutral, { unreachable: true }], "logged-in"), "logged-out");
  assert.equal(matcher.deriveSessionStatus([{ unreachable: true }], "logged-in"), "unknown");
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
