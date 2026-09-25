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

test("detects login-page redirects and strong logged-out page text", function () {
  assert.equal(matcher.isLoginPage("https://secure.login.gov/?state=x", ""), true);
  assert.equal(matcher.isLoginPage("https://public.era.nih.gov/commonsplus/public/login.era", ""), true);
  assert.equal(matcher.isLoginPage("https://public.era.nih.gov/commons/", "You have been logged out."), true);
  assert.equal(matcher.isLoginPage("https://public.era.nih.gov/commons/", "Your session has expired", false), true);
  assert.equal(matcher.isLoginPage("https://public.era.nih.gov/commons/home", "Welcome to eRA Commons"), false);
});

test("recognizes only the explicit login and logout URLs", function () {
  assert.equal(matcher.isLoginUrl("https://www.era.nih.gov/erahelp/commons/commons/access/login.htm"), false);
  assert.equal(matcher.isLoginUrl("https://public.era.nih.gov/commonsplus/public/login.era"), true);
  assert.equal(matcher.isLoginUrl("https://secure.login.gov/"), true);
  assert.equal(matcher.isLoginUrl("https://public.era.nih.gov/commons/authi/public/do?action=logout"), true);
  assert.equal(matcher.isLoginUrl("https://public.era.nih.gov/commonsplus/home.era"), false);
});

test("does not treat Login.gov text on a page with a logout control as logged out", function () {
  assert.equal(
    matcher.isLoginPage(
      "https://public.era.nih.gov/commons/home",
      "Account protection is provided by Login.gov. Logout",
      true
    ),
    false
  );
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

test("derives session status across all relevant tab results", function () {
  var active = { managerPresent: true, minsLeftBefore: 41, minsLeftAfter: 45 };
  var expired = { managerPresent: true, minsLeftBefore: -1, minsLeftAfter: -1 };
  var login = { managerPresent: false, minsLeftBefore: null, isLoginPage: true };
  var unknown = { managerPresent: false, minsLeftBefore: null };
  assert.equal(matcher.deriveSessionStatus([expired, active]), "logged-in");
  assert.equal(matcher.deriveSessionStatus([expired, login]), "logged-out");
  assert.equal(matcher.deriveSessionStatus([{ serverRedirectedToLogin: true }, login]), "logged-out");
  assert.equal(matcher.deriveSessionStatus([{ ...active, serverRedirectedToLogin: true }]), "logged-out");
  assert.equal(matcher.deriveSessionStatus([login, unknown]), "unknown");
  assert.equal(matcher.deriveSessionStatus([]), "unknown");
});

test("formats a nudge log line without query strings", function () {
  var line = matcher.formatLogLine({
    type: "nudge",
    at: new Date(2026, 0, 1, 10, 4).getTime(),
    path: "/commonsplus/home.era?secret=value",
    managerPresent: true,
    minsLeftBefore: 41.24,
    minsLeftAfter: 44.96,
    serverStatus: 200,
    serverRedirectedToLogin: false
  });
  assert.equal(line, "10:04 nudge /commonsplus/home.era: timer 41.2 -> 45.0 min, server 200");
  assert.equal(line.includes("secret"), false);
});

test("identifies pages excluded from status and page-load tracking", function () {
  assert.equal(matcher.isIgnoredEraUrl("https://www.era.nih.gov/news"), true);
  assert.equal(matcher.isIgnoredEraUrl("https://public.era.nih.gov/erahelp/commons/index.htm"), true);
  assert.equal(matcher.isIgnoredEraUrl("https://public.era.nih.gov/commonsplus/home.era"), false);
});
