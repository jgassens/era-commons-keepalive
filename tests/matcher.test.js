"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var matcher = require("../src/matcher.js");

function node(text, selectors) {
  return {
    innerText: text,
    querySelectorAll: function (selector) { return selectors && selectors[selector] || []; }
  };
}

var REGION = '[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"], [role="alert"]';
var CONTROLS = 'button, input[type="button"], input[type="submit"], [role="button"]';

test("finds a continue button in a timeout dialog", function () {
  var continueButton = node("Stay signed in");
  var dialog = node("Your session will expire because of inactivity.", { [CONTROLS]: [continueButton] });
  var documentLike = node("", { [REGION]: [dialog] });
  assert.equal(matcher.findTimeoutContinueButton(documentLike), continueButton);
});

test("ignores a continue button in an unrelated dialog", function () {
  var continueButton = node("Continue");
  var dialog = node("Continue editing your application.", { [CONTROLS]: [continueButton] });
  var documentLike = node("", { [REGION]: [dialog] });
  assert.equal(matcher.findTimeoutContinueButton(documentLike), null);
});

test("never selects logout or sign-out actions in a timeout dialog", function () {
  var logout = node("Log out");
  var signout = node("Sign out");
  var dialog = node("Your session timeout is approaching.", { [CONTROLS]: [logout, signout] });
  var documentLike = node("", { [REGION]: [dialog] });
  assert.equal(matcher.findTimeoutContinueButton(documentLike), null);
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

test("ping URLs discard the current path and query string", function () {
  assert.equal(
    matcher.pingUrlFor("https://public.era.nih.gov/commons/apply?action=submit#review"),
    "https://public.era.nih.gov/commons/"
  );
  assert.equal(
    matcher.pingUrlFor("https://staging.era.nih.gov/anything/here?dangerous=true"),
    "https://staging.era.nih.gov/"
  );
});
