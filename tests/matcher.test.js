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

test("detects login-page redirect URLs and logged-out page text", function () {
  assert.equal(matcher.isLoginPage("https://secure.login.gov/?state=x", ""), true);
  assert.equal(matcher.isLoginPage("https://public.era.nih.gov/commons/login", ""), true);
  assert.equal(matcher.isLoginPage("https://public.era.nih.gov/commons/", "You have been logged out."), true);
  assert.equal(matcher.isLoginPage("https://public.era.nih.gov/commons/home", "Welcome to eRA Commons"), false);
});
