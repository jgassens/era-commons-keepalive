"use strict";

importScripts("src/matcher.js");

var matcher = globalThis.EraKeepAlive;
var ALARM_NAME = "era-keep-alive";
var NUDGE_PERIOD_MINUTES = 4;
var LATE_ALARM_MS = 60 * 1000;
var ERA_TAB_QUERY = { url: ["https://*.era.nih.gov/*"] };
var CONTENT_FILES = ["src/matcher.js", "content.js"];
var DEFAULT_STATE = {
  enabled: true,
  pingServer: false,
  sessionStatus: "unknown",
  sessionStartedAt: null,
  lastNudgeAt: null,
  eraLogoutAt: null,
  lastUserPageLoadAt: null,
  lastAutoClick: null,
  lastServerResult: null,
  logoutRecords: []
};
var logWrite = Promise.resolve();

function getState() {
  return chrome.storage.local.get(DEFAULT_STATE);
}

function setState(values) {
  return chrome.storage.local.set(values);
}

function minutesBetween(from, to) {
  return typeof from === "number" && typeof to === "number" ?
    matcher.roundMinutes(Math.max(0, (to - from) / 60000)) : null;
}

// Every write joins one chain so entries are never lost to a race. A failed
// write is reported and dropped, so the chain always keeps going.
function appendDiagnosticEntries(entries) {
  if (!entries.length) return logWrite;
  logWrite = logWrite.then(async function () {
    try {
      var stored = await chrome.storage.local.get({ diagnosticLog: [] });
      var log = (stored.diagnosticLog || []).concat(entries).slice(-200);
      await chrome.storage.local.set({ diagnosticLog: log });
    } catch (error) {
      console.warn("eRA Keep Alive: could not write diagnostic log", error);
    }
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

async function queryEraTabs() {
  var tabs = await chrome.tabs.query(ERA_TAB_QUERY);
  return tabs.filter(function (tab) { return !matcher.isIgnoredEraUrl(tab.url); });
}

async function configureAlarm() {
  var state = await getState();
  if (!state.enabled) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  var tabs = await queryEraTabs();
  if (!tabs.length) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  var existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: NUDGE_PERIOD_MINUTES });
  }
}

// Tabs that were open before the extension was installed, updated or
// restarted have no live content script. Give them one.
async function injectIntoOpenTabs() {
  var tabs = await chrome.tabs.query(ERA_TAB_QUERY);
  await Promise.all(tabs.map(async function (tab) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    } catch (error) {
      console.warn("eRA Keep Alive: could not inject into tab " + tab.id, error);
    }
  }));
}

function unreachableResult(tab) {
  return {
    tabId: tab.id,
    path: matcher.safePath(tab.url),
    unreachable: true,
    managerPresent: false,
    minsLeftBefore: null,
    minsLeftAfter: null,
    logoutAtAfter: null,
    isLoginPage: matcher.isLoginUrl(tab.url),
    ignored: false
  };
}

async function sendToTab(tab, message) {
  try {
    return (await chrome.tabs.sendMessage(tab.id, message)) || null;
  } catch (error) {
    return null;
  }
}

function probeResult(tab, reply) {
  return {
    tabId: tab.id,
    path: matcher.safePath(reply.path || tab.url),
    managerPresent: !!reply.managerPresent,
    minsLeftBefore: typeof reply.minsLeft === "number" ? reply.minsLeft : null,
    isLoginPage: matcher.isLoginUrl(tab.url),
    ignored: false
  };
}

// Read-only look at every non-ignored eRA tab: nothing is scrolled or pinged.
async function probeTabs(tabs) {
  return Promise.all(tabs.map(async function (tab) {
    var reply = await sendToTab(tab, { type: "probe" });
    return { tab: tab, reply: reply, result: reply ? probeResult(tab, reply) : unreachableResult(tab) };
  }));
}

async function nudgeTab(tab, ping) {
  var reply = await sendToTab(tab, { type: "nudge-activity", ping: ping });
  if (!reply) return unreachableResult(tab);
  return {
    tabId: tab.id,
    path: matcher.safePath(reply.path || tab.url),
    managerPresent: !!reply.managerPresent,
    minsLeftBefore: typeof reply.minsLeftBefore === "number" ? reply.minsLeftBefore : null,
    minsLeftAfter: typeof reply.minsLeftAfter === "number" ? reply.minsLeftAfter : null,
    logoutAtAfter: typeof reply.logoutAtAfter === "number" ? reply.logoutAtAfter : null,
    serverCalled: !!reply.serverCalled,
    serverStatus: typeof reply.serverStatus === "number" ? reply.serverStatus : null,
    serverRejected: !!reply.serverRejected,
    serverError: !!reply.serverError,
    serverRedirectedToLogin: !!reply.serverRedirectedToLogin,
    isLoginPage: matcher.isLoginUrl(tab.url),
    ignored: false
  };
}

function nudgeLogEntry(result, at) {
  return {
    type: "nudge",
    at: at,
    path: result.path,
    unreachable: !!result.unreachable,
    managerPresent: result.managerPresent,
    minsLeftBefore: matcher.roundMinutes(result.minsLeftBefore),
    minsLeftAfter: matcher.roundMinutes(result.minsLeftAfter),
    pingServer: !!result.pingServer,
    serverCalled: !!result.serverCalled,
    serverStatus: typeof result.serverStatus === "number" ? result.serverStatus : null,
    serverRejected: !!result.serverRejected,
    serverError: !!result.serverError,
    serverRedirectedToLogin: !!result.serverRedirectedToLogin
  };
}

function transitionExplanation(status, explained) {
  var wanted = status === "logged-in" ? "active" : status === "logged-out" ? "ended" : null;
  var match = wanted && explained.find(function (item) { return item.classification === wanted; });
  if (match) return { reason: match.reason, path: match.result.path };
  if (explained.length && explained.every(function (item) { return item.result.unreachable; })) {
    return { reason: "could not reach any eRA tab", path: null };
  }
  return { reason: "no tab shows a live eRA timer", path: null };
}

// The same transition logic serves alarms and page loads. options.nudged is
// true only when the results came from a nudge (so they carry a fresh cookie).
async function applyResults(results, at, options) {
  options = options || {};
  var prior = await getState();
  var priorStatus = prior.sessionStatus;
  var explained = results.filter(function (result) { return !result.ignored; }).map(function (result) {
    var explanation = matcher.explainTabResult(result, priorStatus);
    return { result: result, classification: explanation.classification, reason: explanation.reason };
  });
  var nextStatus = matcher.deriveSessionStatus(results, priorStatus);
  var updates = { sessionStatus: nextStatus };
  var active = explained.find(function (item) { return item.classification === "active"; });

  if (options.nudged) {
    if (active) {
      updates.lastNudgeAt = at;
      updates.eraLogoutAt = active.result.logoutAtAfter;
      var pinged = results.find(function (result) { return result.serverCalled; });
      updates.lastServerResult = matcher.describeServer(pinged || { pingServer: !!prior.pingServer });
    } else {
      updates.eraLogoutAt = null;
    }
  }
  if (nextStatus === "logged-out") updates.eraLogoutAt = null;
  if (nextStatus === "logged-in" && priorStatus !== "logged-in") updates.sessionStartedAt = at;

  var detail = transitionExplanation(nextStatus, explained);
  if (priorStatus !== nextStatus) {
    await appendDiagnosticEntries([{
      type: "status",
      at: at,
      from: priorStatus,
      to: nextStatus,
      reason: detail.reason,
      path: detail.path
    }]);
  }

  // The logout record and the notification share this one condition.
  var sessionEnded = priorStatus === "logged-in" && nextStatus === "logged-out";
  if (sessionEnded) {
    var sessionStartedAt = prior.sessionStartedAt;
    var lastNudgeAt = typeof prior.lastNudgeAt === "number" &&
      (typeof sessionStartedAt !== "number" || prior.lastNudgeAt >= sessionStartedAt) ? prior.lastNudgeAt : null;
    var record = {
      loggedOutDetectedAt: at,
      reason: detail.reason,
      path: detail.path,
      pingServer: !!prior.pingServer,
      sessionStartedAt: sessionStartedAt,
      minutesSinceSignIn: minutesBetween(sessionStartedAt, at),
      lastNudgeAt: lastNudgeAt,
      minutesSinceLastNudge: minutesBetween(lastNudgeAt, at),
      lastUserPageLoadAt: prior.lastUserPageLoadAt,
      minutesSinceLastPageLoad: minutesBetween(prior.lastUserPageLoadAt, at),
      minutesLeftAtLastNudge: lastNudgeAt === null || typeof prior.eraLogoutAt !== "number" ? null :
        matcher.roundMinutes((prior.eraLogoutAt - lastNudgeAt) / 60000),
      lastServerPing: prior.lastServerResult
    };
    updates.logoutRecords = [record].concat(prior.logoutRecords || []).slice(0, 10);
  }

  await setState(updates);
  await updateBadge();
  if (nextStatus === "logged-out") await chrome.alarms.clear(ALARM_NAME);
  if (sessionEnded) {
    await chrome.notifications.create("era-session-ended", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "eRA Commons session ended - log in again",
      message: "Please log in again to continue working."
    });
  }
  return nextStatus;
}

async function handleNoTabs(state, at, entries) {
  entries.push({ type: "no-tabs", at: at, from: state.sessionStatus });
  await appendDiagnosticEntries(entries);
  await setState({ sessionStatus: "unknown", eraLogoutAt: null });
  await updateBadge();
  await chrome.alarms.clear(ALARM_NAME);
}

async function nudgeEraTabs(alarm) {
  try {
    var state = await getState();
    if (!state.enabled) return;
    var at = Date.now();
    var entries = [];
    if (alarm && typeof alarm.scheduledTime === "number" && at - alarm.scheduledTime > LATE_ALARM_MS) {
      entries.push({ type: "alarm-late", at: at, minutesLate: matcher.roundMinutes((at - alarm.scheduledTime) / 60000) });
    }
    var tabs = await queryEraTabs();
    if (!tabs.length) {
      await handleNoTabs(state, at, entries);
      return;
    }

    // One server ping per alarm per keep-alive URL, from one active tab.
    var probes = await probeTabs(tabs);
    var pingTabIds = {};
    if (state.pingServer) {
      var seenUrls = {};
      probes.forEach(function (probe) {
        var url = probe.reply && probe.reply.keepAliveUrl;
        if (!url || seenUrls[url] || matcher.classifyTabResult(probe.result, state.sessionStatus) !== "active") return;
        seenUrls[url] = true;
        pingTabIds[probe.tab.id] = true;
      });
    }
    var results = await Promise.all(probes.map(function (probe) {
      return probe.reply ? nudgeTab(probe.tab, !!pingTabIds[probe.tab.id]) : probe.result;
    }));
    results.forEach(function (result) {
      result.pingServer = !!state.pingServer;
      entries.push(nudgeLogEntry(result, at));
    });
    await appendDiagnosticEntries(entries);
    await applyResults(results, at, { nudged: true });
  } catch (error) {
    console.warn("eRA Keep Alive: nudge failed", error);
  }
}

async function handlePageReady(message, sender) {
  var state = await getState();
  if (!state.enabled || message.ignored) return;
  var at = message.at || Date.now();
  var senderTab = sender && sender.tab;
  var result = {
    tabId: senderTab ? senderTab.id : null,
    path: matcher.safePath(message.path),
    managerPresent: !!message.managerPresent,
    minsLeftBefore: typeof message.minsLeft === "number" ? message.minsLeft : null,
    isLoginPage: !!message.isLoginPage,
    ignored: false
  };
  await appendDiagnosticEntries([{
    type: "page-load",
    at: at,
    path: result.path,
    isLoginPage: result.isLoginPage,
    managerPresent: result.managerPresent,
    minsLeft: matcher.roundMinutes(result.minsLeftBefore)
  }]);
  if (!result.isLoginPage && result.managerPresent) await setState({ lastUserPageLoadAt: at });

  var classification = matcher.classifyTabResult(result, state.sessionStatus);
  if (classification === "active") {
    await applyResults([result], at, { nudged: false });
  } else if (classification === "ended") {
    // Judge by every open eRA tab, as an alarm would, but trust this page's
    // own report for its tab: it may already have left eRA.
    var others = (await probeTabs(await queryEraTabs())).map(function (probe) { return probe.result; })
      .filter(function (other) { return result.tabId === null || other.tabId !== result.tabId; });
    var status = await applyResults([result].concat(others), at, { nudged: false });
    if (status === "logged-out") return;
  }
  if (!result.isLoginPage) await configureAlarm();
}

function handleMessage(message, sender) {
  if (!message) return Promise.resolve();
  if (message.type === "auto-click") {
    return (async function () {
      var state = await getState();
      if (!state.enabled) return;
      var clickAt = message.at || Date.now();
      await setState({ lastAutoClick: clickAt });
      await appendDiagnosticEntries([{ type: "auto-click", at: clickAt, path: matcher.safePath(message.path) }]);
    })();
  }
  if (message.type === "era-page-ready") return handlePageReady(message, sender);
  return Promise.resolve();
}

async function handleEnabledChange(newValue) {
  if (!newValue) {
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
}

async function startUp(defaultsToFill) {
  if (defaultsToFill) {
    var stored = await chrome.storage.local.get(["enabled", "pingServer"]);
    var fill = {};
    if (typeof stored.enabled !== "boolean") fill.enabled = true;
    if (typeof stored.pingServer !== "boolean") fill.pingServer = false;
    if (Object.keys(fill).length) await setState(fill);
  }
  await injectIntoOpenTabs();
  await configureAlarm();
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(function () {
  startUp(true).catch(function (error) { console.warn("eRA Keep Alive: install setup failed", error); });
});

chrome.runtime.onStartup.addListener(function () {
  startUp(false).catch(function (error) { console.warn("eRA Keep Alive: startup failed", error); });
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === ALARM_NAME) nudgeEraTabs(alarm);
});

chrome.runtime.onMessage.addListener(function (message, sender) {
  handleMessage(message, sender).catch(function (error) {
    console.warn("eRA Keep Alive: message handling failed", error);
  });
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local" || !changes.enabled) return;
  handleEnabledChange(changes.enabled.newValue).catch(function (error) {
    console.warn("eRA Keep Alive: could not apply the on/off switch", error);
  });
});

updateBadge();
