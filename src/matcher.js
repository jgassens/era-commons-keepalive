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

  var ERA_COOKIE_NAME = "ERA_SESSION_TIMEOUT_COOKIE";

  // The cookie's value is eRA's logout-at time in epoch milliseconds.
  function parseEraCookieValue(rawValue) {
    var value = String(rawValue === null || typeof rawValue === "undefined" ? "" : rawValue).trim();
    try {
      value = decodeURIComponent(value);
    } catch (error) {
      return null;
    }
    if (!/^\d+$/.test(value)) return null;
    var logoutAt = Number(value);
    return Number.isSafeInteger(logoutAt) ? logoutAt : null;
  }

  function parseEraLogoutAt(cookieString) {
    var cookies = String(cookieString || "").split(";");
    for (var i = 0; i < cookies.length; i += 1) {
      var parts = cookies[i].split("=");
      var name = parts.shift().trim();
      if (name !== ERA_COOKIE_NAME) continue;
      return parseEraCookieValue(parts.join("="));
    }
    return null;
  }

  function isEraTimeoutCookie(cookie) {
    if (!cookie || cookie.name !== ERA_COOKIE_NAME) return false;
    var domain = String(cookie.domain || "").toLowerCase().replace(/^\./, "");
    return domain === "era.nih.gov" || /\.era\.nih\.gov$/.test(domain);
  }

  // What one chrome.cookies.onChanged event says. Chrome reports a rewrite as
  // a removal with cause "overwrite" followed by a set; that removal means
  // nothing. eRA's logout writes the cookie with a past expiry
  // ("expired_overwrite"); chrome.cookies.remove reports "explicit".
  function classifyCookieChange(changeInfo, now) {
    if (!changeInfo || !isEraTimeoutCookie(changeInfo.cookie)) return { kind: "ignore" };
    if (changeInfo.removed) {
      if (changeInfo.cause === "expired") return { kind: "ended", reason: "eRA timer cookie expired" };
      if (changeInfo.cause === "explicit" || changeInfo.cause === "expired_overwrite") {
        return { kind: "ended", reason: "eRA timer cookie deleted" };
      }
      return { kind: "ignore" };
    }
    var logoutAt = parseEraCookieValue(changeInfo.cookie.value);
    return logoutAt !== null && logoutAt > now ? { kind: "live", logoutAt: logoutAt } : { kind: "ignore" };
  }

  // One summary of every eRA timeout cookie Chrome holds; the latest time wins.
  // state is "live", "expired" or "missing".
  function summarizeEraCookies(cookies, now) {
    var latest = null;
    (cookies || []).forEach(function (cookie) {
      if (!isEraTimeoutCookie(cookie)) return;
      var logoutAt = parseEraCookieValue(cookie.value);
      if (logoutAt !== null && (latest === null || logoutAt > latest)) latest = logoutAt;
    });
    if (latest === null) return { state: "missing", logoutAt: null, minsLeft: null };
    return { state: latest > now ? "live" : "expired", logoutAt: latest, minsLeft: (latest - now) / 60000 };
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

  function tabMinutesLeft(result) {
    return typeof result.minsLeftAfter === "number" ? result.minsLeftAfter : result.minsLeftBefore;
  }

  function hasLiveCookie(result) {
    var minutes = tabMinutesLeft(result);
    return typeof minutes === "number" && minutes > 0;
  }

  // The one place that decides what a tab result says about the session.
  // Returns { classification: "active" | "ended" | "neutral", reason, weak }.
  // "weak" ended evidence rests only on the cookie this tab saw, or on the
  // tab's URL alone, so a live cookie read straight from Chrome overrides it.
  // priorStatus matters only
  // for a missing or expired cookie: that ends the session only when the
  // extension had already seen it logged in.
  function explainTabResult(result, priorStatus) {
    if (!result || result.ignored) return { classification: "neutral", reason: "ignored page" };
    // Judged from the tab's URL, so this holds even for a tab we cannot reach.
    // eRA deletes its cookie before it logs out, so a live cookie outranks it.
    if (result.isLoginPage) return { classification: "ended", reason: "login or logout page", weak: true, loginPage: true };
    if (result.unreachable) return { classification: "neutral", reason: "could not reach tab" };
    if (result.disabled) return { classification: "neutral", reason: "extension off in this tab" };
    var live = hasLiveCookie(result);
    // A rejected keep-alive alone does not end a session whose timer is live.
    if ((result.serverRejected || result.serverRedirectedToLogin) && !live) {
      return { classification: "ended", reason: "server rejected keep-alive (redirect) and no live eRA timer", weak: true };
    }
    if (result.managerPresent && live) return { classification: "active", reason: "live eRA timer" };
    if (!live && priorStatus === "logged-in") {
      return {
        classification: "ended",
        reason: typeof tabMinutesLeft(result) === "number" ? "cookie expired" : "cookie deleted",
        weak: true
      };
    }
    return { classification: "neutral", reason: live ? "no timeout manager" : "no live eRA timer" };
  }

  function classifyTabResult(result, priorStatus) {
    return explainTabResult(result, priorStatus).classification;
  }

  // Decides the session status from tab results plus, when known, the cookie
  // read straight from Chrome ({ state: "live" | "expired" | "missing" }, or
  // null when it could not be read). Only positive evidence changes status:
  // with nothing but neutral results the prior status stands.
  // Returns { status, reason, path }.
  function decideSession(results, priorStatus, cookie) {
    priorStatus = priorStatus || "unknown";
    var explained = (results || []).filter(function (result) {
      return result && !result.ignored;
    }).map(function (result) {
      var explanation = explainTabResult(result, priorStatus);
      explanation.path = result.path || null;
      return explanation;
    });
    var cookieState = cookie && cookie.state;
    function decided(status, test) {
      var match = explained.find(test);
      if (!match) return null;
      var reason = match.reason;
      // A login page with the cookie gone is eRA's own logout, and says so.
      if (match.loginPage && (cookieState === "missing" || cookieState === "expired")) {
        reason += cookieState === "expired" ? " (eRA timer cookie expired)" : " (eRA timer cookie deleted)";
      }
      return { status: status, reason: reason, path: match.path };
    }
    var found = decided("logged-in", function (item) { return item.classification === "active"; }) ||
      decided("logged-out", function (item) { return item.classification === "ended" && !item.weak; });
    if (found) return found;
    if (cookieState === "live") {
      // A cookie that is merely still there does not undo a logout the
      // extension saw; an eRA page with a live timer (or a fresh cookie
      // write) does that.
      if (priorStatus === "logged-out") return { status: priorStatus, reason: null, path: null };
      return { status: "logged-in", reason: "live eRA timer cookie", path: null };
    }
    found = decided("logged-out", function (item) { return item.classification === "ended"; });
    if (found) return found;
    if ((cookieState === "missing" || cookieState === "expired") && priorStatus === "logged-in") {
      return {
        status: "logged-out",
        reason: cookieState === "expired" ? "eRA timer cookie expired" : "eRA timer cookie deleted",
        path: null
      };
    }
    return { status: priorStatus, reason: null, path: null };
  }

  function deriveSessionStatus(results, priorStatus, cookie) {
    return decideSession(results, priorStatus, cookie).status;
  }

  // The extra line the popup shows under a logout record, or null.
  function logoutNote(record) {
    if (!record) return null;
    var reason = String(record.reason || "");
    if (/cookie deleted/i.test(reason)) {
      return "eRA deleted its own timeout cookie — eRA's page timer or the Logout button ended the session.";
    }
    if (/cookie expired/i.test(reason)) {
      return "eRA's own timer ran out before the next activity nudge.";
    }
    if (typeof record.estimatedEndAt === "number" || /no eRA tab/i.test(reason)) {
      return "No eRA tab was open, so nothing kept the session alive; eRA's timer ran out or the browser was closed.";
    }
    if (typeof record.minutesSinceLastNudge === "number" && typeof record.minutesLeftAtLastNudge === "number" &&
      record.minutesSinceLastNudge < record.minutesLeftAtLastNudge) {
      return "eRA's own timer still had time left — something else ended the session (server or a hard limit).";
    }
    return null;
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
    if (entry.serverTimeout) return "server timeout";
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
      // Entries from before 1.4.0 carry no "to" and always went to unknown.
      if (!entry.to) {
        return prefix + "no eRA tabs open" +
          (entry.from && entry.from !== "unknown" ? " (status " + entry.from + " -> unknown)" : "");
      }
      var cookieText = entry.cookie ? ", " + describeCookie(entry.minsLeft) : ", cookie unreadable";
      return prefix + "no eRA tabs open" + cookieText +
        (entry.to === "idle" ? "; not keeping the session alive until an eRA tab is open (4-minute timer stopped)" :
          entry.to === "logged-in" ? "; still logged in, nothing to nudge (4-minute timer stopped)" : "");
    }
    if (entry.type === "server-warning") {
      return prefix + "server rejected keep-alive (redirect) " + path + "; eRA timer still live, still nudging";
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
    ERA_COOKIE_NAME: ERA_COOKIE_NAME,
    parseEraCookieValue: parseEraCookieValue,
    parseEraLogoutAt: parseEraLogoutAt,
    isEraTimeoutCookie: isEraTimeoutCookie,
    classifyCookieChange: classifyCookieChange,
    summarizeEraCookies: summarizeEraCookies,
    isEraLogoutUrl: isEraLogoutUrl,
    isLoginUrl: isLoginUrl,
    isIgnoredEraUrl: isIgnoredEraUrl,
    safePath: safePath,
    buildKeepSessionAliveUrl: buildKeepSessionAliveUrl,
    explainTabResult: explainTabResult,
    classifyTabResult: classifyTabResult,
    decideSession: decideSession,
    deriveSessionStatus: deriveSessionStatus,
    logoutNote: logoutNote,
    roundMinutes: roundMinutes,
    formatMinutes: formatMinutes,
    formatTime: formatTime,
    describeServer: describeServer,
    formatLogLine: formatLogLine
  };
});
