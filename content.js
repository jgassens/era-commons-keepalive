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

  function isWarningModalVisible() {
    return [
      document.querySelector("#sessionTimeoutModalDialog"),
      document.querySelector("#sessionTimeoutModalDialogNative")
    ].some(isElementVisible);
  }

  function lookForWarning() {
    var button = matcher.findTimeoutContinueButton(document, isElementVisible);
    var now = Date.now();
    if (!button || now - (lastClickAtByButton.get(button) || 0) < CLICK_COOLDOWN_MS) return;
    lastClickAtByButton.set(button, now);
    button.click();
    report({ type: "auto-click", at: now });
  }

  function pageSignals(documentLike) {
    var body = documentLike && documentLike.body;
    if (!body) return { visibleText: "", hasLogoutControl: false };

    var textBody = body.cloneNode(true);
    Array.prototype.forEach.call(textBody.querySelectorAll("script, style, noscript"), function (node) {
      node.remove();
    });

    var hasLogoutControl = Array.prototype.some.call(documentLike.querySelectorAll("a, button"), function (control) {
      var text = String(control.textContent || "");
      var href = String(control.getAttribute("href") || "");
      return /\b(?:logout|log\s+out|sign\s+out)\b/i.test(text) ||
        /\b(?:logout|log\s+out|sign\s+out)\b/i.test(href);
    });

    return {
      visibleText: textBody.textContent || "",
      hasLogoutControl: hasLogoutControl
    };
  }

  function isLoggedOutDocument(url, documentLike) {
    if (matcher.isEraLogoutUrl(url)) return true;
    var signals = pageSignals(documentLike);
    return matcher.isLoginPage(url, signals.visibleText, signals.hasLogoutControl);
  }

  function reportPageState() {
    report({
      type: "era-page-ready",
      url: location.href,
      at: Date.now(),
      isLoginPage: isLoggedOutDocument(location.href, document)
    });
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== "nudge-activity") return;
    if (isLoggedOutDocument(location.href, document)) {
      sendResponse({ nudged: false, logoutAt: null, loggedOut: true });
      return;
    }
    if (!document.querySelector("#session-timeout-control") || isWarningModalVisible()) {
      sendResponse({ nudged: false, logoutAt: null, loggedOut: false });
      return;
    }

    // eRA's own document-level jQuery handler treats this like normal activity
    // and renews the timeout cookie. It does not move the user's viewport.
    document.dispatchEvent(new Event("scroll"));
    sendResponse({
      nudged: true,
      logoutAt: matcher.parseEraLogoutAt(document.cookie),
      loggedOut: false
    });
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
