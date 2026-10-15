(function () {
  "use strict";

  var INSTANCE_KEY = "__eraKeepAliveContent";
  var STOP_EVENT = "era-keep-alive-stop";
  var KNOWN_MODAL_IDS = ["sessionTimeoutModalDialog", "sessionTimeoutModalDialogNative"];
  var CLICK_COOLDOWN_MS = 30 * 1000;
  var OBSERVER_THROTTLE_MS = 500;
  var PING_TIMEOUT_MS = 15 * 1000;
  var ACTIVITY_REPORT_MS = 1000;
  var ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "input", "change", "click", "wheel", "scroll", "touchstart"];
  var lastUserActivityAt = null;
  var activityTimer = null;
  var editedFields = new Set();
  var untrackedEdits = false;

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
  // Once the extension has seen the session end, eRA's own logout is allowed
  // to show: Continue is not pressed on a dead session's warning.
  var loggedOut = false;
  var stopped = false;
  var observer = null;
  var pollTimer = null;
  var observerTimer = null;
  // The optional diagnostic recorder: page events are reported only while
  // its switch is on. The background drops them if it is not permitted.
  var recorderOn = false;
  var lastPath = location.pathname;
  var modalShown = null;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (observer) observer.disconnect();
    window.clearInterval(pollTimer);
    window.clearTimeout(observerTimer);
    window.clearTimeout(activityTimer);
    activityListeners(false);
    document.removeEventListener(STOP_EVENT, stop);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    windowListeners(false);
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

  function recordPage(what, extra) {
    if (stopped || !recorderOn) return;
    report(Object.assign({
      type: "recorder-page-event",
      what: what,
      at: Date.now(),
      path: location.pathname,
      visibility: document.visibilityState
    }, extra || {}));
  }

  // Only browser-generated input counts. In particular, our synthetic scroll
  // and Continue clicks must never move the user's inactivity deadline.
  function onUserActivity(event) {
    if (stopped || !enabled || loggedOut || event.isTrusted !== true ||
        matcher.isIgnoredEraUrl(location.href) || matcher.isLoginUrl(location.href) || !managerControl()) return;
    if (event.type === "input" || event.type === "change") {
      var field = event.target;
      if (field && /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName || "")) {
        if (!isTransientControl(field)) editedFields.add(field);
      } else {
        // Custom editors have no native saved-value baseline. Keep protecting
        // them until a page load rather than guessing whether Save succeeded.
        untrackedEdits = true;
      }
    }
    lastUserActivityAt = Date.now();
    if (activityTimer !== null) return;
    activityTimer = window.setTimeout(function () {
      activityTimer = null;
      if (stopped || !enabled || loggedOut) return;
      report({ type: "era-user-activity", at: lastUserActivityAt });
    }, ACTIVITY_REPORT_MS);
  }

  function activityListeners(add) {
    ACTIVITY_EVENTS.forEach(function (type) {
      document[add ? "addEventListener" : "removeEventListener"](type, onUserActivity, true);
    });
  }

  function isTransientControl(field) {
    var type = String(field.type || "").toLowerCase();
    return ["hidden", "submit", "button", "reset", "image", "search"].indexOf(type) !== -1 ||
      !!(field.closest && field.closest(".dt-search, .dt-length, .dataTables_filter, .dataTables_length"));
  }

  function isIarScoreField(field) {
    return location.pathname === "/iar/finalscores/view.era" &&
      /^allAppls_(?:criteria_score|finalScore)_/.test(field.id || "");
  }

  function savedFieldValue(field) {
    // IAR renders data-initialValue from server data and rebuilds its table
    // after Save. It is not the current input value or a Save-button click.
    if (isIarScoreField(field) && typeof field.getAttribute === "function") {
      var initial = field.getAttribute("data-initialvalue");
      if (initial !== null) return initial;
    }
    return field.defaultValue;
  }

  function fieldHasUnsavedEdits(field) {
    if (isTransientControl(field)) return false;
    var type = String(field.type || "").toLowerCase();
    if (type === "checkbox" || type === "radio") return field.checked !== field.defaultChecked;
    if (type === "file") return !!(field.files && field.files.length);
    if (field.options) {
      var defaults = Array.prototype.some.call(field.options, function (option) { return option.defaultSelected; });
      return Array.prototype.some.call(field.options, function (option, index) {
        return option.selected !== (option.defaultSelected || (!defaults && !field.multiple && index === 0));
      });
    }
    return field.value !== savedFieldValue(field);
  }

  function hasUnsavedEdits() {
    if (untrackedEdits) return true;
    var dirty = false;
    editedFields.forEach(function (field) {
      if (!fieldHasUnsavedEdits(field)) {
        editedFields.delete(field);
        return;
      }
      // Filtering a table can detach edited rows; that must not make their
      // edits look saved. Retire an old IAR field only when the replacement
      // carries its edited value back as a server-supplied saved baseline.
      var replacement = field.id && document.getElementById(field.id);
      if (isIarScoreField(field) && replacement && replacement !== field &&
          isIarScoreField(replacement) && savedFieldValue(replacement) === field.value) {
        editedFields.delete(field);
        if (fieldHasUnsavedEdits(replacement)) dirty = true;
      } else {
        dirty = true;
      }
    });
    // This also protects edits made before injection. Comparisons stay in
    // this page's memory; values are never recorded or sent to the extension.
    return dirty || Array.prototype.some.call(document.querySelectorAll("input, textarea, select"), fieldHasUnsavedEdits);
  }

  function onVisibilityChange() {
    recordPage("visibilitychange");
  }

  function onPageShow(event) {
    recordPage("pageshow", { persisted: !!(event && event.persisted) });
  }

  function onPageHide(event) {
    recordPage("pagehide", { persisted: !!(event && event.persisted) });
  }

  // eRA pages are mostly full loads, but a path change without one is still
  // worth a line: history navigation, or the Navigation API where it exists.
  function checkNavigation() {
    var path = location.pathname;
    if (path === lastPath) return;
    recordPage("navigate", { fromPath: lastPath });
    lastPath = path;
  }

  function windowListeners(add) {
    var method = add ? "addEventListener" : "removeEventListener";
    try {
      if (typeof window[method] === "function") {
        window[method]("pageshow", onPageShow);
        window[method]("pagehide", onPageHide);
        window[method]("popstate", checkNavigation);
      }
      if (window.navigation && typeof window.navigation[method] === "function") {
        window.navigation[method]("navigatesuccess", checkNavigation);
      }
    } catch (error) {
      // A page without these events simply records fewer of them.
    }
  }

  function visibleKnownModal() {
    for (var i = 0; i < KNOWN_MODAL_IDS.length; i += 1) {
      if (isElementVisible(document.getElementById(KNOWN_MODAL_IDS[i]))) return KNOWN_MODAL_IDS[i];
    }
    return null;
  }

  // eRA's own timeout warning appearing or going away.
  function checkModalForRecorder(visibleId) {
    if (!recorderOn) return;
    var shown = !!visibleId;
    if (shown !== modalShown && (modalShown !== null || shown)) {
      recordPage(shown ? "modal-shown" : "modal-hidden", { modal: visibleId || null });
    }
    modalShown = shown;
  }

  function recorderPoll() {
    if (stopped || !recorderOn) return;
    checkNavigation();
    checkModalForRecorder(visibleKnownModal());
  }

  function recorderStarted() {
    lastPath = location.pathname;
    modalShown = null;
    recordPage("load");
    recorderPoll();
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
    if (!enabled || loggedOut) return;
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
    var visibleId = visibleKnownModal();
    checkModalForRecorder(visibleId);
    if (visibleId) lookForWarning();
  }

  function onMutations() {
    if (stopped || (!enabled && !recorderOn) || observerTimer !== null) return;
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
      keepAliveUrl: keepAliveUrl(control),
      lastUserActivityAt: lastUserActivityAt,
      unsavedEdits: hasUnsavedEdits()
    };
  }

  // When this page itself loaded. The script can be injected long after that
  // (on an extension update), and the background needs the real load time.
  function pageLoadedAt() {
    try {
      var origin = typeof performance !== "undefined" ? performance.timeOrigin : null;
      return typeof origin === "number" && Number.isFinite(origin) ? Math.round(origin) : null;
    } catch (error) {
      return null;
    }
  }

  function reportPageState() {
    var state = pageState();
    report({
      type: "era-page-ready",
      at: Date.now(),
      loadedAt: pageLoadedAt(),
      path: state.path,
      ignored: matcher.isIgnoredEraUrl(location.href),
      isLoginPage: matcher.isLoginUrl(location.href),
      managerPresent: state.managerPresent,
      minsLeft: state.minsLeft
    });
  }

  function pingServer(url, result) {
    result.serverCalled = true;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timedOut = false;
    var timer = null;
    // A hung request must not hold up the background's whole tick. The race
    // settles even if the aborted fetch never does.
    var timeout = new Promise(function (resolve) {
      timer = window.setTimeout(function () {
        timedOut = true;
        if (controller) controller.abort();
        resolve();
      }, PING_TIMEOUT_MS);
    });
    // redirect: "manual" keeps a rejected session from following eRA into
    // its login page; the redirect itself is the answer we want.
    var request = fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "manual",
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      if (timedOut) return;
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
      if (timedOut) return;
      result.serverError = true;
      result.serverStatus = null;
    });
    return Promise.race([request, timeout]).then(function () {
      window.clearTimeout(timer);
      if (timedOut) {
        result.serverTimeout = true;
        result.serverStatus = null;
      }
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
      serverError: false,
      serverTimeout: false
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
      var state = pageState();
      state.disabled = !enabled;
      sendResponse(state);
      return false;
    }
    if (message.type === "refresh-page") {
      var state = pageState();
      var reason = null;
      if (!enabled || loggedOut || !state.managerPresent || !(state.logoutAt > Date.now()) ||
          matcher.isLoginUrl(location.href) || matcher.isIgnoredEraUrl(location.href)) reason = "inactive page";
      else if (hasUnsavedEdits()) reason = "unsaved edits";
      // Avoid replaying an action or prompting to resubmit a saved form.
      else if (/\/(?:save|submit|upload|delete|remove|update|generate)[^/]*\.era$/i.test(location.pathname)) reason = "form action page";
      else if (typeof message.activityCutoff !== "number" ||
          (lastUserActivityAt !== null && lastUserActivityAt > message.activityCutoff)) reason = "recent activity";
      sendResponse({ refreshed: !reason, reason: reason });
      if (!reason) location.reload();
      return false;
    }
    if (message.type === "nudge-activity") return nudge(message, sendResponse);
    return false;
  }

  function onStorageChanged(changes, area) {
    if (area !== "local" || (!changes.enabled && !changes.sessionStatus && !changes.recorderOn)) return;
    if (changes.recorderOn) {
      var wasOn = recorderOn;
      recorderOn = changes.recorderOn.newValue === true;
      if (recorderOn && !wasOn) recorderStarted();
    }
    if (!changes.enabled && !changes.sessionStatus) return;
    if (changes.enabled) enabled = changes.enabled.newValue !== false;
    if (changes.sessionStatus) loggedOut = changes.sessionStatus.newValue === "logged-out";
    if (enabled && !loggedOut) lookForWarning();
  }

  var instance = { alive: function () { return !stopped && contextAlive(); }, stop: stop };
  globalThis[INSTANCE_KEY] = instance;
  document.addEventListener(STOP_EVENT, stop);
  document.addEventListener("visibilitychange", onVisibilityChange);
  windowListeners(true);
  activityListeners(true);

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.storage.local.get({ enabled: true, sessionStatus: "unknown", recorderOn: false }).then(function (stored) {
    enabled = stored.enabled !== false;
    loggedOut = stored.sessionStatus === "logged-out";
    recorderOn = stored.recorderOn === true;
    if (recorderOn) recorderStarted();
    lookForWarning();
  }).catch(stopIfOrphaned);

  observer = new MutationObserver(onMutations);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "aria-hidden"]
  });
  pollTimer = window.setInterval(function () {
    lookForWarning();
    recorderPoll();
  }, 15000);
  reportPageState();
})();
