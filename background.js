"use strict";

importScripts("src/matcher.js");

var matcher = globalThis.EraKeepAlive;
var ALARM_NAME = "era-keep-alive";
var NUDGE_PERIOD_MINUTES = 4;
var ERA_TAB_QUERY = { url: ["https://*.era.nih.gov/*"] };
var DEFAULT_STATE = {
  enabled: true,
  sessionStatus: "unknown",
  lastNudgeAt: null,
  eraLogoutAt: null,
  lastUserPageLoadAt: null,
  lastAutoClick: null,
  lastNudgeTimerMinutes: null,
  lastServerStatus: null,
  logoutRecords: [],
  diagnosticLog: []
};
var logWrite = Promise.resolve();

function getState() {
  return chrome.storage.local.get(DEFAULT_STATE);
}

function setState(values) {
  return chrome.storage.local.set(values);
}

function appendDiagnosticEntries(entries) {
  if (!entries.length) return Promise.resolve();
  logWrite = logWrite.then(async function () {
    var stored = await chrome.storage.local.get({ diagnosticLog: [] });
    var log = (stored.diagnosticLog || []).concat(entries).slice(-200);
    await chrome.storage.local.set({ diagnosticLog: log });
  });
  return logWrite;
}

async function updateBadge() {
  var state = await getState();
  if (!state.enabled) {
    await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
    await chrome.action.setBadgeText({ text: "OFF" });
  } else if (state.sessionStatus === "logged-out") {
    await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
    await chrome.action.setBadgeText({ text: "!" });
  } else if (state.sessionStatus === "logged-in") {
    await chrome.action.setBadgeBackgroundColor({ color: "#15803d" });
    await chrome.action.setBadgeText({ text: "ON" });
  } else {
    await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
    await chrome.action.setBadgeText({ text: "?" });
  }
}

async function configureAlarm() {
  var state = await getState();
  if (!state.enabled) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  var tabs = await chrome.tabs.query(ERA_TAB_QUERY);
  if (!tabs.length) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  var existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: NUDGE_PERIOD_MINUTES });
  }
}

function transitionDetails(status, results) {
  results = results.filter(function (item) { return !item.ignored; });
  var result;
  if (status === "logged-in") {
    result = results.find(function (item) {
      return !item.isLoginPage && !item.serverRedirectedToLogin && item.managerPresent &&
        ((typeof item.minsLeftAfter === "number" && item.minsLeftAfter > 0) ||
          (typeof item.minsLeftBefore === "number" && item.minsLeftBefore > 0));
    });
    return { reason: "active eRA timer", path: result && result.path };
  }
  result = results.find(function (item) { return item.serverRedirectedToLogin; });
  if (result) return { reason: "server redirected to login", path: result.path };
  result = results.find(function (item) {
    return typeof item.minsLeftBefore === "number" && item.minsLeftBefore <= 0;
  });
  if (result) return { reason: "eRA timer expired", path: result.path };
  result = results.find(function (item) { return item.isLoginPage; });
  if (result) return { reason: "login or logout page", path: result.path };
  return { reason: "no active eRA timer found", path: results[0] && results[0].path };
}

async function applyAlarmResults(results, at) {
  var prior = await getState();
  var nextStatus = matcher.deriveSessionStatus(results);
  var updates = { sessionStatus: nextStatus };
  var active = results.find(function (result) {
    return !result.ignored && result.managerPresent &&
      typeof result.minsLeftBefore === "number" && result.minsLeftBefore > 0;
  });
  if (active) {
    updates.lastNudgeAt = at;
    updates.lastNudgeTimerMinutes = active.minsLeftAfter;
    updates.lastServerStatus = active.serverStatus;
    updates.eraLogoutAt = typeof active.minsLeftAfter === "number" ?
      at + active.minsLeftAfter * 60000 : null;
  } else {
    updates.eraLogoutAt = null;
  }

  var detail = transitionDetails(nextStatus, results);
  if (prior.sessionStatus !== nextStatus) {
    await appendDiagnosticEntries([{
      type: "status",
      at: at,
      from: prior.sessionStatus,
      to: nextStatus,
      reason: detail.reason,
      path: detail.path ? matcher.safePath(detail.path) : null
    }]);
  }

  if (prior.sessionStatus === "logged-in" && nextStatus === "logged-out") {
    var effectiveLastNudgeAt = active ? at : prior.lastNudgeAt;
    var effectiveTimerMinutes = active ? active.minsLeftAfter : prior.lastNudgeTimerMinutes;
    var effectiveServerStatus = active ? active.serverStatus : prior.lastServerStatus;
    var minutesSinceLastNudge = effectiveLastNudgeAt === null ? null :
      Math.max(0, Math.round((at - effectiveLastNudgeAt) / 60000));
    var minutesSinceLastPageLoad = prior.lastUserPageLoadAt === null ? null :
      Math.max(0, Math.round((at - prior.lastUserPageLoadAt) / 60000));
    var record = {
      loggedOutDetectedAt: at,
      lastNudgeAt: effectiveLastNudgeAt,
      lastUserPageLoadAt: prior.lastUserPageLoadAt,
      minutesSinceLastNudge: minutesSinceLastNudge,
      minutesSinceLastPageLoad: minutesSinceLastPageLoad,
      minutesLeftAtLastNudge: effectiveTimerMinutes,
      lastServerPingStatus: effectiveServerStatus
    };
    updates.logoutRecords = [record].concat(prior.logoutRecords || []).slice(0, 10);
  }

  await setState(updates);
  await updateBadge();
  if (prior.sessionStatus !== "logged-out" && nextStatus === "logged-out") {
    await chrome.notifications.create("era-session-ended", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "eRA Commons session ended - log in again",
      message: "Please log in again to continue working."
    });
  }
}

async function nudgeEraTabs() {
  var state = await getState();
  if (!state.enabled) return;
  var tabs = await chrome.tabs.query(ERA_TAB_QUERY);
  if (!tabs.length) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  var results = await Promise.all(tabs.map(async function (tab) {
    var path = matcher.safePath(tab.url);
    var ignored = matcher.isIgnoredEraUrl(tab.url);
    var result;
    try {
      result = await chrome.tabs.sendMessage(tab.id, { type: "nudge-activity" });
    } catch (error) {
      result = null;
    }
    result = result || {
      path: path,
      managerPresent: false,
      minsLeftBefore: null,
      minsLeftAfter: null,
      serverStatus: null,
      serverRedirectedToLogin: false
    };
    return {
      path: matcher.safePath(result.path || path),
      managerPresent: !!result.managerPresent,
      minsLeftBefore: typeof result.minsLeftBefore === "number" ? result.minsLeftBefore : null,
      minsLeftAfter: typeof result.minsLeftAfter === "number" ? result.minsLeftAfter : null,
      serverStatus: typeof result.serverStatus === "number" ? result.serverStatus : null,
      serverRedirectedToLogin: !!result.serverRedirectedToLogin,
      isLoginPage: matcher.isLoginUrl(tab.url),
      ignored: ignored
    };
  }));

  var at = Date.now();
  await appendDiagnosticEntries(results.map(function (result) {
    return {
      type: "nudge",
      at: at,
      path: result.path,
      managerPresent: result.managerPresent,
      minsLeftBefore: result.minsLeftBefore,
      minsLeftAfter: result.minsLeftAfter,
      serverStatus: result.serverStatus,
      serverRedirectedToLogin: result.serverRedirectedToLogin
    };
  }));
  await applyAlarmResults(results, at);
}

chrome.runtime.onInstalled.addListener(async function () {
  var stored = await chrome.storage.local.get("enabled");
  if (typeof stored.enabled !== "boolean") await setState({ enabled: true });
  await configureAlarm();
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async function () {
  await configureAlarm();
  await updateBadge();
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === ALARM_NAME) nudgeEraTabs();
});

chrome.runtime.onMessage.addListener(function (message) {
  if (!message) return;
  if (message.type === "auto-click") {
    var clickAt = message.at || Date.now();
    var clickPath = matcher.safePath(message.path);
    setState({ lastAutoClick: clickAt });
    appendDiagnosticEntries([{ type: "auto-click", at: clickAt, path: clickPath }]);
  }
  if (message.type === "era-page-ready") {
    configureAlarm();
    if (message.ignored) return;
    var pageAt = message.at || Date.now();
    var pagePath = matcher.safePath(message.path);
    setState({ lastUserPageLoadAt: pageAt });
    appendDiagnosticEntries([{
      type: "page-load",
      at: pageAt,
      path: pagePath,
      managerPresent: !!message.managerPresent,
      minsLeft: typeof message.minsLeft === "number" ? message.minsLeft : null
    }]);
  }
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local" || !changes.enabled) return;
  (async function () {
    if (!changes.enabled.newValue) {
      await chrome.alarms.clear(ALARM_NAME);
    } else {
      var prior = await getState();
      if (prior.sessionStatus !== "unknown") {
        await appendDiagnosticEntries([{
          type: "status",
          at: Date.now(),
          from: prior.sessionStatus,
          to: "unknown",
          reason: "extension enabled",
          path: null
        }]);
      }
      await setState({ sessionStatus: "unknown" });
      await configureAlarm();
    }
    await updateBadge();
  })();
});

updateBadge();
