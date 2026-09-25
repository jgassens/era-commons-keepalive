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

  function findTimeoutContinueButton(documentLike) {
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
      if (!isTimeoutWarningText(textOf(region))) continue;
      var controls = listFrom(region, 'button, input[type="button"], input[type="submit"], [role="button"]');
      for (var j = 0; j < controls.length; j += 1) {
        if (isContinueButtonText(textOf(controls[j]))) return controls[j];
      }
    }
    return null;
  }

  function pingUrlFor(locationLike) {
    var source = locationLike || "";
    var hostname = String(source.hostname || source.host || "").toLowerCase();
    var origin = source.origin;

    if (!hostname || !origin) {
      try {
        var parsed = new URL(String(source.href || source));
        hostname = parsed.hostname.toLowerCase();
        origin = parsed.origin;
      } catch (error) {
        return "";
      }
    }

    if (hostname === "public.era.nih.gov") return "https://public.era.nih.gov/commons/";
    return String(origin).replace(/\/+$/, "") + "/";
  }

  function isLoginUrl(url) {
    try {
      var parsed = new URL(String(url || ""));
      var hostname = parsed.hostname.toLowerCase();
      return hostname === "login.gov" || /\.login\.gov$/.test(hostname) ||
        /(?:^|\/)login-type(?:\/|$)/i.test(parsed.pathname);
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
    findTimeoutContinueButton: findTimeoutContinueButton,
    pingUrlFor: pingUrlFor,
    isLoginUrl: isLoginUrl,
    isLoginPage: isLoginPage
  };
});
