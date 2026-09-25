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

  // eRA sometimes appends ";jsessionid=..." path parameters to a segment.
  // They carry a session identifier, so they are removed from every segment.
  function stripPathParameters(pathname) {
    return String(pathname || "").split("/").map(function (segment) {
      return segment.split(";")[0];
    }).join("/");
  }

  function isEraLogoutUrl(url) {
    try {
      var parsed = new URL(String(url || ""));
      return /\/authi\/public\/do$/i.test(stripPathParameters(parsed.pathname)) &&
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
        /\/public\/login\.(?:era|jsp|do)$/i.test(stripPathParameters(parsed.pathname)) ||
        isEraLogoutUrl(parsed.href);
    } catch (error) {
      return false;
    }
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
    var path;
    try {
      path = new URL(String(url || "")).pathname;
    } catch (error) {
      path = String(url || "").split(/[?#]/)[0];
    }
    path = stripPathParameters(path);
    return path.charAt(0) === "/" ? path : "/";
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

  function hasLiveCookie(result) {
    return typeof result.minsLeftBefore === "number" && result.minsLeftBefore > 0;
  }

  // The one place that decides what a tab result says about the session.
  // Returns { classification: "active" | "ended" | "neutral", reason }.
  // priorStatus matters only for a missing or expired cookie: that ends the
  // session only when the extension had already seen it logged in.
  function explainTabResult(result, priorStatus) {
    if (!result || result.ignored) return { classification: "neutral", reason: "ignored page" };
    if (result.unreachable) return { classification: "neutral", reason: "could not reach tab" };
    if (result.isLoginPage) return { classification: "ended", reason: "login or logout page" };
    if (result.serverRedirectedToLogin) return { classification: "ended", reason: "server redirected to login" };
    if (result.serverRejected) return { classification: "ended", reason: "server rejected keep-alive (redirect)" };
    var live = hasLiveCookie(result);
    if (result.managerPresent && live) return { classification: "active", reason: "live eRA timer" };
    if (!live && priorStatus === "logged-in") {
      return {
        classification: "ended",
        reason: typeof result.minsLeftBefore === "number" ? "cookie expired" : "cookie deleted"
      };
    }
    return { classification: "neutral", reason: live ? "no timeout manager" : "no live eRA timer" };
  }

  function classifyTabResult(result, priorStatus) {
    return explainTabResult(result, priorStatus).classification;
  }

  function deriveSessionStatus(results, priorStatus) {
    var relevant = (results || []).filter(function (result) {
      return result && !result.ignored;
    });
    // No eRA tabs to judge by: the caller decides what that means, so keep prior.
    if (!relevant.length) return priorStatus || "unknown";
    var classes = relevant.map(function (result) {
      return classifyTabResult(result, priorStatus);
    });
    if (classes.indexOf("active") !== -1) return "logged-in";
    if (classes.indexOf("ended") !== -1) return "logged-out";
    return "unknown";
  }

  function roundMinutes(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
  }

  function oneDecimal(value) {
    var rounded = roundMinutes(value);
    return rounded === null ? null : rounded.toFixed(1);
  }

  // "12.3 min", or null when there is no number to show.
  function formatMinutes(value) {
    var text = oneDecimal(value);
    return text === null ? null : text + " min";
  }

  // Date and time for the popup; "Never" when there is no time.
  function formatTime(value) {
    if (value === null || typeof value === "undefined") return "Never";
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "Never";
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function shortTime(value) {
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "--:--";
    return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  }

  function describeServer(entry) {
    entry = entry || {};
    if (entry.serverError) return "server error";
    if (entry.serverRejected) return "server rejected (redirect)";
    if (entry.serverRedirectedToLogin) return "server redirected to login";
    if (typeof entry.serverStatus === "number") return "server " + entry.serverStatus;
    if (entry.pingServer === false) return "server not called (ping off)";
    return "server not called";
  }

  function describeCookie(before, after) {
    if (typeof before !== "number") return "cookie deleted";
    var text = "cookie " + oneDecimal(before);
    if (typeof after === "number" && oneDecimal(after) !== oneDecimal(before)) text += " -> " + oneDecimal(after);
    return text + " min" + (before <= 0 ? " (expired)" : "");
  }

  function formatLogLine(entry) {
    entry = entry || {};
    var prefix = shortTime(entry.at) + " ";
    var path = safePath(entry.path || "/");
    if (entry.type === "nudge") {
      if (entry.unreachable) return prefix + "nudge " + path + ": could not reach tab (reload it)";
      var detail = (entry.managerPresent ? "" : "no timeout manager, ") +
        describeCookie(entry.minsLeftBefore, entry.minsLeftAfter);
      return prefix + "nudge " + path + ": " + detail + ", " + describeServer(entry);
    }
    if (entry.type === "page-load") {
      var pageDetail = entry.isLoginPage ? "login or logout page" :
        (entry.managerPresent ? "" : "no timeout manager, ") + describeCookie(entry.minsLeft);
      return prefix + "page load " + path + ": " + pageDetail;
    }
    if (entry.type === "status") {
      return prefix + "status " + entry.from + " -> " + entry.to + ": " +
        String(entry.reason || "status changed") + (entry.path ? " (" + path + ")" : "");
    }
    if (entry.type === "no-tabs") {
      return prefix + "no eRA tabs open" +
        (entry.from && entry.from !== "unknown" ? " (status " + entry.from + " -> unknown)" : "");
    }
    if (entry.type === "alarm-late") {
      return prefix + "alarm late by " + oneDecimal(entry.minutesLate) + " min (computer asleep?)";
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
    isIgnoredEraUrl: isIgnoredEraUrl,
    safePath: safePath,
    buildKeepSessionAliveUrl: buildKeepSessionAliveUrl,
    explainTabResult: explainTabResult,
    classifyTabResult: classifyTabResult,
    deriveSessionStatus: deriveSessionStatus,
    roundMinutes: roundMinutes,
    formatMinutes: formatMinutes,
    formatTime: formatTime,
    describeServer: describeServer,
    formatLogLine: formatLogLine
  };
});
