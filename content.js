(function () {
  "use strict";

  var matcher = globalThis.EraKeepAlive;
  var lastClickAtByButton = new WeakMap();
  var CLICK_COOLDOWN_MS = 30 * 1000;

  function report(message) {
    chrome.runtime.sendMessage(message).catch(function () {
      // The extension may be reloaded while this content script is still alive.
    });
  }

  function isElementVisible(element) {
    if (!element || typeof element.getClientRects !== "function") return false;
    var style = window.getComputedStyle(element);
    return matcher.isVisible({
      clientRectCount: element.getClientRects().length,
      display: style.display,
      visibility: style.visibility
    });
  }

  function lookForWarning() {
    var button = matcher.findTimeoutContinueButton(document, isElementVisible);
    var now = Date.now();
    if (!button || now - (lastClickAtByButton.get(button) || 0) < CLICK_COOLDOWN_MS) return;
    lastClickAtByButton.set(button, now);
    button.click();
    report({ type: "auto-click", at: now, path: location.pathname });
  }

  function minutesLeft(logoutAt, now) {
    return typeof logoutAt === "number" ? (logoutAt - now) / 60000 : null;
  }

  function managerControl() {
    return document.querySelector("#session-timeout-control");
  }

  function reportPageState() {
    var control = managerControl();
    var now = Date.now();
    report({
      type: "era-page-ready",
      at: now,
      path: location.pathname,
      ignored: matcher.isIgnoredEraUrl(location.href),
      isLoginPage: matcher.isLoginUrl(location.href),
      managerPresent: !!control,
      minsLeft: minutesLeft(matcher.parseEraLogoutAt(document.cookie), now)
    });
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== "nudge-activity") return;
    var control = managerControl();
    var now = Date.now();
    var logoutAtBefore = matcher.parseEraLogoutAt(document.cookie);
    var result = {
      path: location.pathname,
      managerPresent: !!control,
      minsLeftBefore: minutesLeft(logoutAtBefore, now),
      minsLeftAfter: minutesLeft(logoutAtBefore, now),
      serverStatus: null,
      serverRedirectedToLogin: false
    };
    if (!control || logoutAtBefore === null || logoutAtBefore <= now) {
      sendResponse(result);
      return;
    }

    // eRA's own document-level jQuery handler treats this like normal activity
    // and renews the timeout cookie. It does not move the user's viewport.
    document.dispatchEvent(new Event("scroll"));
    result.minsLeftAfter = minutesLeft(matcher.parseEraLogoutAt(document.cookie), Date.now());

    var keepAliveUrl = matcher.buildKeepSessionAliveUrl(
      control.getAttribute("data-base-url"),
      control.getAttribute("data-current-app-name"),
      location.href
    );
    if (!keepAliveUrl) {
      sendResponse(result);
      return;
    }
    fetch(keepAliveUrl, {
      method: "GET",
      credentials: "include",
      cache: "no-store"
    }).then(function (response) {
      result.serverStatus = response.status;
      result.serverRedirectedToLogin = matcher.isLoginUrl(response.url);
      sendResponse(result);
    }).catch(function () {
      sendResponse(result);
    });
    return true;
  });

  var observer = new MutationObserver(lookForWarning);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "aria-hidden"]
  });
  window.setInterval(lookForWarning, 15000);
  lookForWarning();
  reportPageState();
})();
