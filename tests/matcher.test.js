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
  assert.equal(matcher.isLoginPage("https://public.era.nih.gov/commons/login-type", ""), true);
  assert.equal(matcher.isLoginPage("https://public.era.nih.gov/commons/", "You have been logged out."), true);
  assert.equal(matcher.isLoginPage("https://public.era.nih.gov/commons/", "Your session has expired", false), true);
  assert.equal(matcher.isLoginPage("https://public.era.nih.gov/commons/home", "Welcome to eRA Commons"), false);
});

test("detects login-related pathname segments and login.gov hosts", function () {
  [
    "https://public.era.nih.gov/commons/public/login.do",
    "https://public.era.nih.gov/login",
    "https://public.era.nih.gov/signin?x=1",
    "https://public.era.nih.gov/era/Logout.jsp",
    "https://public.era.nih.gov/account/sign-in-now",
    "https://public.era.nih.gov/sessiontimeout-warning",
    "https://public.era.nih.gov/timeout-page",
    "https://login.gov/",
    "https://secure.login.gov/"
  ].forEach(function (url) {
    assert.equal(matcher.isLoginUrl(url), true, url);
  });
});

test("only checks pathname segments, not unrelated paths or query strings", function () {
  [
    "/commons/",
    "/commons/personProfile",
    "/commons/help?topic=login"
  ].forEach(function (url) {
    assert.equal(matcher.isLoginUrl("https://public.era.nih.gov" + url), false, url);
  });
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
