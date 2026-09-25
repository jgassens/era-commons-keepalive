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
      return parsed.pathname.indexOf("/authi/public/do") !== -1 &&
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
        /(?:^|\/)(?:login|signin|sign-in|logout|logged-out|sessiontimeout|timeout)/i.test(parsed.pathname);
    } catch (error) {
      return false;
    }
  }

  function isLoginPage(url, visibleText, hasLogoutControl) {
    var text = String(visibleText || "").replace(/\s+/g, " ").trim();
    var loggedOutText = /\byou\s+have\s+been\s+logged\s+out\b|\byour\s+session\s+has\s+(?:expired|ended|timed\s+out)\b|\bsession\s+expired\b/i.test(text);
    return isLoginUrl(url) || (loggedOutText && !hasLogoutControl);
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
    isLoginPage: isLoginPage
  };
});
