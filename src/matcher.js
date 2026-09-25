/* Pure matching helpers shared by the content script and Node tests. */
(function (root, factory) {
  var api = factory();
  root.EraKeepAlive = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var timeoutWords = /\bsession\b[\s\S]{0,160}\b(timeout|timed\s*out|expire(?:d|s|ing)?|logged\s*out|inactiv(?:e|ity))\b|\b(timeout|timed\s*out|expire(?:d|s|ing)?|logged\s*out|inactiv(?:e|ity))\b[\s\S]{0,160}\bsession\b/i;
  var continueWords = /^(?:continue|stay\s+logged\s+in|stay\s+signed\s+in|extend(?:\s+(?:session|login))?|keep\s+me\s+signed\s+in|keep\s+working|yes)$/i;
  var forbiddenWords = /\b(?:logout|log\s*out|sign\s*out|end\s+session|cancel)\b/i;

  function textOf(node) {
    if (!node) return "";
    return String(node.innerText || node.textContent || node.value || node.getAttribute && node.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isTimeoutWarningText(text) {
    return timeoutWords.test(String(text || ""));
  }

  function isContinueButtonText(text) {
    var normalized = String(text || "").replace(/\s+/g, " ").trim();
    return !!normalized && !forbiddenWords.test(normalized) && continueWords.test(normalized);
  }

  function listFrom(node, selector) {
    if (!node || typeof node.querySelectorAll !== "function") return [];
    return Array.prototype.slice.call(node.querySelectorAll(selector));
  }

  function isVisible(visibility) {
    return !!visibility && Number(visibility.clientRectCount) > 0 &&
      String(visibility.display || "").toLowerCase() !== "none" &&
      String(visibility.visibility || "").toLowerCase() !== "hidden";
  }

  function nodeFrom(documentLike, selector) {
    if (!documentLike || typeof documentLike.querySelector !== "function") return null;
    return documentLike.querySelector(selector);
  }

  function isSafeContinueButton(button) {
    if (!button) return false;
    var id = String(button.id || button.getAttribute && button.getAttribute("id") || "");
    return id !== "logoutBtn" && id !== "native-logoutBtn" && !forbiddenWords.test(textOf(button));
  }

  function findTimeoutContinueButton(documentLike, isNodeVisible) {
    // The caller supplies the browser-specific visibility check. Keeping it an
    // argument makes the selection logic testable with small fake DOM objects.
    isNodeVisible = typeof isNodeVisible === "function" ? isNodeVisible : function () { return true; };

    var knownModals = [
      { region: "#sessionTimeoutModalDialog", button: "#extendSessionBtn" },
      { region: "#sessionTimeoutModalDialogNative", button: "#native-extendSessionBtn" }
    ];
    for (var knownIndex = 0; knownIndex < knownModals.length; knownIndex += 1) {
      var known = knownModals[knownIndex];
      var knownRegion = nodeFrom(documentLike, known.region);
      if (!knownRegion || !isNodeVisible(knownRegion)) continue;
      var knownButton = nodeFrom(knownRegion, known.button) || nodeFrom(documentLike, known.button);
      if (knownButton && isNodeVisible(knownButton) && isSafeContinueButton(knownButton)) {
        return knownButton;
      }
    }

    // Restrict matches to semantic dialog-like regions. This deliberately avoids
    // scanning all buttons on a page, where a similarly worded action is unsafe.
    var regions = listFrom(documentLike, '[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"], [role="alert"]');
    // Some older eRA pages may use a named modal container instead of ARIA.
    // It is still subject to the same full timeout-text and exact-control checks.
    var namedRegions = listFrom(documentLike, '[class*="dialog" i], [class*="modal" i], [class*="timeout" i], [id*="dialog" i], [id*="modal" i]');
    namedRegions.forEach(function (region) {
      if (regions.indexOf(region) === -1) regions.push(region);
    });
    for (var i = 0; i < regions.length; i += 1) {
      var region = regions[i];
      if (!isNodeVisible(region) || !isTimeoutWarningText(textOf(region))) continue;
      var controls = listFrom(region, 'button, input[type="button"], input[type="submit"], [role="button"]');
      for (var j = 0; j < controls.length; j += 1) {
        if (isNodeVisible(controls[j]) && isSafeContinueButton(controls[j]) &&
          isContinueButtonText(textOf(controls[j]))) return controls[j];
      }
    }
    return null;
  }

  function parseEraLogoutAt(cookieString) {
    var cookies = String(cookieString || "").split(";");
    for (var i = 0; i < cookies.length; i += 1) {
      var parts = cookies[i].split("=");
      var name = parts.shift().trim();
      if (name !== "ERA_SESSION_TIMEOUT_COOKIE") continue;
      var value = parts.join("=").trim();
      try {
        value = decodeURIComponent(value);
      } catch (error) {
        return null;
      }
      if (!/^\d+$/.test(value)) return null;
      var logoutAt = Number(value);
      return Number.isSafeInteger(logoutAt) ? logoutAt : null;
    }
    return null;
  }

  function isEraLogoutUrl(url) {
    try {
      var parsed = new URL(String(url || ""));
      return /\/authi\/public\/do$/i.test(parsed.pathname) &&
        String(parsed.searchParams.get("action") || "").toLowerCase() === "logout";
    } catch (error) {
      return false;
    }
  }

  function isLoginUrl(url) {
    try {
      var parsed = new URL(String(url || ""));
      var hostname = parsed.hostname.toLowerCase();
      return hostname === "login.gov" || /\.login\.gov$/.test(hostname) ||
        /\/public\/login\.era$/i.test(parsed.pathname) || isEraLogoutUrl(parsed.href);
    } catch (error) {
      return false;
    }
  }

  function isLoginPage(url, visibleText, hasLogoutControl) {
    var text = String(visibleText || "").replace(/\s+/g, " ").trim();
    var loggedOutText = /\byou\s+have\s+been\s+logged\s+out\b|\byour\s+session\s+has\s+(?:expired|ended|timed\s+out)\b|\bsession\s+expired\b/i.test(text);
    return isLoginUrl(url) || (loggedOutText && !hasLogoutControl);
  }

  function isIgnoredEraUrl(url) {
    try {
      var parsed = new URL(String(url || ""));
      return parsed.hostname.toLowerCase() === "www.era.nih.gov" ||
        /(?:^|\/)erahelp(?:\/|$)/i.test(parsed.pathname);
    } catch (error) {
      return false;
    }
  }

  function safePath(url) {
    try {
      return new URL(String(url || "")).pathname || "/";
    } catch (error) {
      var path = String(url || "").split(/[?#]/)[0];
      return path.charAt(0) === "/" ? path : "/";
    }
  }

  function buildKeepSessionAliveUrl(baseUrl, currentAppName, pageUrl) {
    try {
      var page = new URL(String(pageUrl || ""));
      var base = String(baseUrl || "");
      var appName = String(currentAppName || "");
      if (!base) base = page.origin + (appName.charAt(0) === "/" ? "" : "/");
      var target = new URL(base + appName + "/jsp/keepSessionAlive.jsp", page.href);
      if (target.protocol !== "https:" || !target.hostname.toLowerCase().endsWith(".era.nih.gov")) return null;
      return target.href;
    } catch (error) {
      return null;
    }
  }

  function deriveSessionStatus(results) {
    var relevant = (results || []).filter(function (result) {
      return result && !result.ignored;
    });
    if (relevant.some(function (result) {
      return !result.isLoginPage && !result.serverRedirectedToLogin && result.managerPresent &&
        ((typeof result.minsLeftAfter === "number" && result.minsLeftAfter > 0) ||
          (typeof result.minsLeftBefore === "number" && result.minsLeftBefore > 0));
    })) return "logged-in";
    if (relevant.length && relevant.every(function (result) {
      return result.isLoginPage || result.serverRedirectedToLogin ||
        (typeof result.minsLeftBefore === "number" && result.minsLeftBefore <= 0);
    })) return "logged-out";
    return "unknown";
  }

  function oneDecimal(value) {
    return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : null;
  }

  function shortTime(value) {
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "--:--";
    return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  }

  function formatLogLine(entry) {
    entry = entry || {};
    var prefix = shortTime(entry.at) + " ";
    var path = safePath(entry.path || "/");
    if (entry.type === "nudge") {
      var detail;
      if (!entry.managerPresent) detail = "timeout manager not present";
      else if (entry.minsLeftBefore === null || typeof entry.minsLeftBefore === "undefined") detail = "timer missing";
      else if (entry.minsLeftBefore <= 0) detail = "timer expired (" + oneDecimal(entry.minsLeftBefore) + " min)";
      else detail = "timer " + oneDecimal(entry.minsLeftBefore) + " -> " + oneDecimal(entry.minsLeftAfter) + " min";
      var server = entry.serverStatus === null || typeof entry.serverStatus === "undefined" ?
        "server not called" : "server " + entry.serverStatus;
      if (entry.serverRedirectedToLogin) server += " (login redirect)";
      return prefix + "nudge " + path + ": " + detail + ", " + server;
    }
    if (entry.type === "page-load") {
      var pageDetail = !entry.managerPresent ? "timeout manager not present" :
        entry.minsLeft === null || typeof entry.minsLeft === "undefined" ? "timer missing" :
          "timer " + oneDecimal(entry.minsLeft) + " min";
      return prefix + "page load " + path + ": " + pageDetail;
    }
    if (entry.type === "status") {
      return prefix + "status " + entry.from + " -> " + entry.to + ": " +
        String(entry.reason || "status changed") + (entry.path ? " (" + path + ")" : "");
    }
    if (entry.type === "auto-click") return prefix + "continued timeout warning " + path;
    return prefix + String(entry.type || "event") + " " + path;
  }

  return {
    textOf: textOf,
    isTimeoutWarningText: isTimeoutWarningText,
    isContinueButtonText: isContinueButtonText,
    isVisible: isVisible,
    findTimeoutContinueButton: findTimeoutContinueButton,
    parseEraLogoutAt: parseEraLogoutAt,
    isEraLogoutUrl: isEraLogoutUrl,
    isLoginUrl: isLoginUrl,
    isLoginPage: isLoginPage,
    isIgnoredEraUrl: isIgnoredEraUrl,
    safePath: safePath,
    buildKeepSessionAliveUrl: buildKeepSessionAliveUrl,
    deriveSessionStatus: deriveSessionStatus,
    formatLogLine: formatLogLine
  };
});
