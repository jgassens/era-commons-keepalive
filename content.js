(function () {
  "use strict";

  var INSTANCE_KEY = "__eraKeepAliveContent";
  var STOP_EVENT = "era-keep-alive-stop";
  var KNOWN_MODAL_IDS = ["sessionTimeoutModalDialog", "sessionTimeoutModalDialogNative"];
  var CLICK_COOLDOWN_MS = 30 * 1000;
  var OBSERVER_THROTTLE_MS = 500;

  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }

  // The background injects this script into already-open eRA tabs on install,
  // update and startup, so it can arrive twice. A live copy in this world wins.
  var existing = globalThis[INSTANCE_KEY];
  if (existing && existing.alive()) return;
  if (existing) existing.stop();
  // A copy left behind by an older version of the extension may live in a
  // different isolated world, where globalThis is not shared. DOM events are.
  document.dispatchEvent(new CustomEvent(STOP_EVENT));

  var matcher = globalThis.EraKeepAlive;
  var lastClickAtByButton = new WeakMap();
  var enabled = false;
  var stopped = false;
  var observer = null;
  var pollTimer = null;
  var observerTimer = null;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (observer) observer.disconnect();
    window.clearInterval(pollTimer);
    window.clearTimeout(observerTimer);
    document.removeEventListener(STOP_EVENT, stop);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch (error) {
      // An orphaned script cannot reach chrome.* any more; nothing to remove.
    }
    if (globalThis[INSTANCE_KEY] === instance) globalThis[INSTANCE_KEY] = null;
  }

  function stopIfOrphaned(error) {
    if (!contextAlive() || /context invalidated/i.test(String(error && error.message || error))) {
      stop();
      return true;
    }
    return false;
  }

  function report(message) {
    try {
      chrome.runtime.sendMessage(message).catch(stopIfOrphaned);
    } catch (error) {
      stopIfOrphaned(error);
    }
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
    if (stopped) return;
    if (!contextAlive()) {
      stop();
      return;
    }
    if (!enabled) return;
    var button = matcher.findTimeoutContinueButton(document, isElementVisible);
    var now = Date.now();
    if (!button || now - (lastClickAtByButton.get(button) || 0) < CLICK_COOLDOWN_MS) return;
    lastClickAtByButton.set(button, now);
    button.click();
    report({ type: "auto-click", at: now, path: location.pathname });
  }

  // Cheap check for DOM changes: only eRA's two known modal ids. The full
  // heuristic scan runs on the 15-second poll.
  function checkKnownModals() {
    observerTimer = null;
    for (var i = 0; i < KNOWN_MODAL_IDS.length; i += 1) {
      if (isElementVisible(document.getElementById(KNOWN_MODAL_IDS[i]))) {
        lookForWarning();
        return;
      }
    }
  }

  function onMutations() {
    if (stopped || !enabled || observerTimer !== null) return;
    observerTimer = window.setTimeout(checkKnownModals, OBSERVER_THROTTLE_MS);
  }

  function minutesLeft(logoutAt, now) {
    return typeof logoutAt === "number" ? (logoutAt - now) / 60000 : null;
  }

  function managerControl() {
    return document.getElementById("session-timeout-control");
  }

  function keepAliveUrl(control) {
    if (!control) return null;
    return matcher.buildKeepSessionAliveUrl(
      control.getAttribute("data-base-url"),
      control.getAttribute("data-current-app-name"),
      location.href
    );
  }

  function pageState() {
    var control = managerControl();
    var now = Date.now();
    var logoutAt = matcher.parseEraLogoutAt(document.cookie);
    return {
      path: location.pathname,
      managerPresent: !!control,
      logoutAt: logoutAt,
      minsLeft: minutesLeft(logoutAt, now),
      keepAliveUrl: keepAliveUrl(control)
    };
  }

  function reportPageState() {
    var state = pageState();
    report({
      type: "era-page-ready",
      at: Date.now(),
      path: state.path,
      ignored: matcher.isIgnoredEraUrl(location.href),
      isLoginPage: matcher.isLoginUrl(location.href),
      managerPresent: state.managerPresent,
      minsLeft: state.minsLeft
    });
  }

  function pingServer(url, result) {
    result.serverCalled = true;
    // redirect: "manual" keeps a rejected session from following eRA into
    // its login page; the redirect itself is the answer we want.
    return fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "manual"
    }).then(function (response) {
      if (response.body && typeof response.body.cancel === "function") {
        response.body.cancel().catch(function () {});
      }
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        result.serverRejected = true;
        result.serverStatus = response.status || null;
      } else {
        result.serverStatus = response.status;
      }
    }).catch(function () {
      result.serverError = true;
      result.serverStatus = null;
    });
  }

  function nudge(message, sendResponse) {
    var state = pageState();
    var now = Date.now();
    var result = {
      path: state.path,
      managerPresent: state.managerPresent,
      minsLeftBefore: state.minsLeft,
      minsLeftAfter: state.minsLeft,
      logoutAtAfter: state.logoutAt,
      disabled: !enabled,
      serverCalled: false,
      serverStatus: null,
      serverRejected: false,
      serverError: false
    };
    if (!enabled || !state.managerPresent || state.logoutAt === null || state.logoutAt <= now) {
      sendResponse(result);
      return false;
    }

    // eRA's own document-level jQuery handler treats this like normal activity
    // and renews the timeout cookie. It does not move the user's viewport.
    document.dispatchEvent(new Event("scroll"));
    result.logoutAtAfter = matcher.parseEraLogoutAt(document.cookie);
    result.minsLeftAfter = minutesLeft(result.logoutAtAfter, Date.now());

    if (!message.ping || !state.keepAliveUrl) {
      sendResponse(result);
      return false;
    }
    pingServer(state.keepAliveUrl, result).then(function () {
      sendResponse(result);
    });
    return true;
  }

  function onMessage(message, sender, sendResponse) {
    if (stopped || !message) return false;
    if (message.type === "probe") {
      sendResponse(pageState());
      return false;
    }
    if (message.type === "nudge-activity") return nudge(message, sendResponse);
    return false;
  }

  function onStorageChanged(changes, area) {
    if (area !== "local" || !changes.enabled) return;
    enabled = changes.enabled.newValue !== false;
    if (enabled) lookForWarning();
  }

  var instance = { alive: function () { return !stopped && contextAlive(); }, stop: stop };
  globalThis[INSTANCE_KEY] = instance;
  document.addEventListener(STOP_EVENT, stop);

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.storage.local.get({ enabled: true }).then(function (stored) {
    enabled = stored.enabled !== false;
    lookForWarning();
  }).catch(stopIfOrphaned);

  observer = new MutationObserver(onMutations);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "aria-hidden"]
  });
  pollTimer = window.setInterval(lookForWarning, 15000);
  reportPageState();
})();
