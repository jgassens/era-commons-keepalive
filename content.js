(function () {
  "use strict";

  var matcher = globalThis.EraKeepAlive;
  var clickedButtons = new WeakSet();

  function report(message) {
    chrome.runtime.sendMessage(message).catch(function () {
      // The extension may be reloaded while this content script is still alive.
    });
  }

  function lookForWarning() {
    var button = matcher.findTimeoutContinueButton(document);
    if (!button || clickedButtons.has(button)) return;
    clickedButtons.add(button);
    button.click();
    report({ type: "auto-click", at: Date.now() });
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
    if (!message || message.type !== "keep-alive-ping") return;
    fetch(matcher.pingUrlFor(location), { method: "GET", credentials: "include", cache: "no-store" })
      .then(function (response) {
        var login = matcher.isLoginUrl(response.url);
        if (login) return { success: false, loggedOut: true };
        return response.text().then(function (body) {
          var parsed = new DOMParser().parseFromString(body, "text/html");
          return {
            success: response.ok,
            loggedOut: isLoggedOutDocument(response.url, parsed)
          };
        });
      })
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function () {
        sendResponse({ success: false, loggedOut: false });
      });
    return true;
  });

  var observer = new MutationObserver(lookForWarning);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.setInterval(lookForWarning, 15000);
  lookForWarning();
  reportPageState();
})();
