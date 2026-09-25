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

  function reportPageState() {
    report({
      type: "era-page-ready",
      url: location.href,
      at: Date.now(),
      isLoginPage: matcher.isLoginPage(location.href, document.body && document.body.innerText)
    });
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== "keep-alive-ping") return;
    fetch(location.href, { method: "GET", credentials: "include", cache: "no-store" })
      .then(function (response) {
        var login = matcher.isLoginPage(response.url, "");
        if (login) return { success: false, loggedOut: true };
        return response.text().then(function (body) {
          return {
            success: response.ok,
            loggedOut: matcher.isLoginPage(response.url, body.slice(0, 200000))
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
