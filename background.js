"use strict";

importScripts("src/matcher.js");

var matcher = globalThis.EraKeepAlive;
var ALARM_NAME = "era-keep-alive";
var NUDGE_PERIOD_MINUTES = 4;
var LATE_ALARM_MS = 60 * 1000;
// eRA rewrites its cookie on every click, key press and scroll. The stored
// logout time is refreshed only when it moves by at least this much.
var LOGOUT_AT_STEP_MS = 60 * 1000;
var ERA_TAB_QUERY = { url: ["https://*.era.nih.gov/*"] };
var CONTENT_FILES = ["src/matcher.js", "content.js"];
var IDLE_END_REASON = "ended while no eRA tab was open";
// 1.4.3 turned the server ping on by default; see startUp().
var PING_DEFAULT_ON_VERSION = "1.4.3";
var DEFAULT_STATE = {
  enabled: true,
  pingServer: true,
  sessionStatus: "unknown",
  sessionStartedAt: null,
  lastNudgeAt: null,
  // eRA's logout time as seen right after the last nudge. eraLogoutAt moves
  // with every cookie write; this one moves only with a nudge.
  lastNudgeTimerAt: null,
  eraLogoutAt: null,
  // When the last eRA tab closed while the session was live ("idle").
  idleSince: null,
  lastUserPageLoadAt: null,
  lastAutoClick: null,
  lastServerResult: null,
  serverWarning: null,
  logoutRecords: []
};
var logWrite = Promise.resolve();
var statusQueue = Promise.resolve();
var cookieLiveCheckQueued = false;

function getState() {
  return chrome.storage.local.get(DEFAULT_STATE);
}

function setState(values) {
  return chrome.storage.local.set(values);
}

// Every status decision (alarm ticks, page loads, cookie changes, the on/off
// switch) runs one at a time, so two of them can never both see logged-in
// and both record the same logout. A failed task does not stop the queue.
function serialized(task) {
  var run = statusQueue.then(task);
  statusQueue = run.catch(function () {});
  return run;
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

// chrome.action can reject with "No SW" while the service worker is still
// starting (e.g. right after a reload, before this call is the first thing
// to run). That is never worth surfacing: the next badge update supersedes it.
async function setBadge(color, text) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: color });
    await chrome.action.setBadgeText({ text: text });
  } catch (error) {
    console.warn("eRA Keep Alive: could not update the badge", error);
  }
}

async function updateBadge() {
  var state = await getState();
  if (!state.enabled) {
    await setBadge("#6b7280", "OFF");
  } else if (state.sessionStatus === "logged-out") {
    await setBadge("#b91c1c", "!");
  } else if (state.sessionStatus === "logged-in" && state.serverWarning) {
    await setBadge("#b45309", "ON!");
  } else if (state.sessionStatus === "logged-in") {
    await setBadge("#15803d", "ON");
  } else if (state.sessionStatus === "idle") {
    await setBadge("#6b7280", "…");
  } else {
    await setBadge("#6b7280", "?");
  }
}

async function queryEraTabs() {
  var tabs = await chrome.tabs.query(ERA_TAB_QUERY);
  return tabs.filter(function (tab) { return !matcher.isIgnoredEraUrl(tab.url); });
}

// Reads eRA's timeout cookie straight from Chrome. null means it could not
// be read, which is no evidence either way.
async function readEraCookie(now) {
  try {
    return matcher.summarizeEraCookies(await chrome.cookies.getAll({ name: matcher.ERA_COOKIE_NAME }), now);
  } catch (error) {
    console.warn("eRA Keep Alive: could not read the eRA timeout cookie", error);
    return null;
  }
}

// After a logout the alarm stays off until an eRA page with a live timer, or
// a fresh cookie write, sets the status back to logged-in.
async function configureAlarm() {
  var state = await getState();
  if (!state.enabled || state.sessionStatus === "logged-out") {
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
    disabled: !!reply.disabled,
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
    serverTimeout: !!reply.serverTimeout,
    serverRedirectedToLogin: !!reply.serverRedirectedToLogin,
    disabled: !!reply.disabled,
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
    serverTimeout: !!result.serverTimeout,
    serverRedirectedToLogin: !!result.serverRedirectedToLogin
  };
}

function logoutRecord(prior, detail, at) {
  var sessionStartedAt = prior.sessionStartedAt;
  var lastNudgeAt = typeof prior.lastNudgeAt === "number" &&
    (typeof sessionStartedAt !== "number" || prior.lastNudgeAt >= sessionStartedAt) ? prior.lastNudgeAt : null;
  return {
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
    minutesLeftAtLastNudge: lastNudgeAt === null || typeof prior.lastNudgeTimerAt !== "number" ? null :
      matcher.roundMinutes((prior.lastNudgeTimerAt - lastNudgeAt) / 60000),
    estimatedEndAt: typeof detail.estimatedEndAt === "number" ? detail.estimatedEndAt : null,
    lastServerPing: prior.lastServerResult
  };
}

// The one code path for every status change, whatever noticed it. Callers
// run inside serialized(). next is { status, reason, path }, plus
// { silent, estimatedEndAt } for a session that ended while nothing watched.
async function commitStatus(prior, next, at, updates) {
  var priorStatus = prior.sessionStatus;
  var nextStatus = next.status;
  updates = Object.assign({}, updates, { sessionStatus: nextStatus });
  if (nextStatus === "logged-out") {
    updates.eraLogoutAt = null;
    updates.serverWarning = null;
  }
  // Leaving idle for logged-in keeps the sign-in time unless the caller says
  // the session was a new one.
  if (nextStatus === "logged-in" && priorStatus !== "logged-in") {
    if (priorStatus !== "idle" && !("sessionStartedAt" in updates)) updates.sessionStartedAt = at;
    if (!("serverWarning" in updates)) updates.serverWarning = null;
  }
  if (nextStatus === "idle" && priorStatus !== "idle") updates.idleSince = at;
  if (nextStatus !== "idle" && priorStatus === "idle") updates.idleSince = null;

  if (priorStatus !== nextStatus) {
    await appendDiagnosticEntries([{
      type: "status",
      at: at,
      from: priorStatus,
      to: nextStatus,
      reason: next.reason || "status changed",
      path: next.path || null
    }]);
  }

  // Every end of a session is recorded. Only one noticed as it happened is
  // notified: an end found after idle is hours old and never notifies.
  var sessionEnded = (priorStatus === "logged-in" || priorStatus === "idle") && nextStatus === "logged-out";
  var notify = sessionEnded && priorStatus === "logged-in" && !next.silent;
  if (sessionEnded) {
    updates.logoutRecords = [logoutRecord(prior, next, at)].concat(prior.logoutRecords || []).slice(0, 10);
  }

  await setState(updates);
  await updateBadge();
  if (priorStatus !== nextStatus || nextStatus === "logged-out") await configureAlarm();
  if (notify) {
    await chrome.notifications.create("era-session-ended", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "eRA Commons session ended - log in again",
      message: "Please log in again to continue working."
    });
  }
  return nextStatus;
}

// Alarms and page loads both land here. options.nudged is true only when the
// results came from a nudge (so they carry a fresh cookie and server answer);
// options.cookie is the cookie read straight from Chrome, when there is one.
async function applyResults(results, at, options) {
  options = options || {};
  var prior = await getState();
  var decision = matcher.decideSession(results, prior.sessionStatus, options.cookie);
  var updates = {};
  var cookie = options.cookie;

  if (options.nudged) {
    var active = results.find(function (result) {
      return matcher.classifyTabResult(result, prior.sessionStatus) === "active";
    });
    if (active) {
      updates.lastNudgeAt = at;
      updates.lastNudgeTimerAt = active.logoutAtAfter;
      updates.eraLogoutAt = active.logoutAtAfter;
      var pinged = results.find(function (result) { return result.serverCalled; });
      updates.lastServerResult = matcher.describeServer(pinged || { pingServer: !!prior.pingServer });
    } else if (cookie) {
      updates.eraLogoutAt = cookie.state === "live" ? cookie.logoutAt : null;
    }

    var rejected = results.find(function (result) { return result.serverRejected || result.serverRedirectedToLogin; });
    var answered = results.some(function (result) {
      return result.serverCalled && typeof result.serverStatus === "number" && !result.serverRejected;
    });
    if (rejected && decision.status === "logged-in") {
      // eRA's timer is still live, so this is a warning, not a logout.
      updates.serverWarning = { at: at, path: rejected.path };
      await appendDiagnosticEntries([{ type: "server-warning", at: at, path: rejected.path }]);
    } else if (answered) {
      updates.serverWarning = null;
    }
  }
  return commitStatus(prior, decision, at, updates);
}

// The first evidence after idle decides what happened while no eRA tab was
// open. evidence: { cookie, tabsOpen, loginPage, livePage, path }. A live
// cookie means the session carried on; a stale or missing cookie, or a login
// page without a live cookie, means it ended some time ago, so it is recorded
// without a notification. Also used after a browser restart, when prior may
// still be logged-in. Returns the state afterwards.
async function resolveIdle(prior, at, evidence) {
  var cookie = evidence.cookie;
  var live = !!cookie && cookie.state === "live";
  var next;
  var updates = {};
  if ((cookie && !live) || (evidence.loginPage && !live)) {
    var estimate = cookie && typeof cookie.logoutAt === "number" ? cookie.logoutAt : prior.eraLogoutAt;
    next = {
      status: "logged-out",
      reason: IDLE_END_REASON,
      path: evidence.path || null,
      silent: true,
      estimatedEndAt: typeof estimate === "number" ? Math.min(estimate, at) : null
    };
  } else if (evidence.livePage || (live && evidence.tabsOpen)) {
    next = { status: "logged-in", reason: "eRA tab open again", path: evidence.path || null };
    // A cookie set before idle began belongs to some other, older session.
    if (live && typeof prior.idleSince === "number" && cookie.logoutAt <= prior.idleSince) updates.sessionStartedAt = at;
    if (live) updates.eraLogoutAt = cookie.logoutAt;
  } else if (live) {
    next = { status: "idle", reason: "no eRA tabs open", path: null };
    updates.eraLogoutAt = cookie.logoutAt;
  } else {
    return prior;
  }
  await commitStatus(prior, next, at, updates);
  return getState();
}

// With no eRA tab open there is nothing to nudge, so the alarm stops. A
// session the cookie still shows as live goes idle: the extension no longer
// keeps it alive, and the next evidence says whether it survived.
async function handleNoTabs(state, at, entries) {
  var cookie = await readEraCookie(at);
  var priorStatus = state.sessionStatus;
  var after;
  if (priorStatus === "idle") {
    after = (await resolveIdle(state, at, { cookie: cookie, tabsOpen: false })).sessionStatus;
  } else {
    var next;
    if (!cookie) {
      next = { status: priorStatus === "logged-in" ? "idle" : priorStatus, reason: "no eRA tabs open" };
    } else if (cookie.state === "live") {
      next = priorStatus === "logged-out" ? { status: "unknown", reason: "no eRA tabs open" } :
        { status: "idle", reason: "no eRA tabs open" };
    } else if (priorStatus === "logged-in") {
      next = matcher.decideSession([], priorStatus, cookie);
    } else {
      next = { status: "unknown", reason: "no eRA tabs open" };
    }
    var updates = {};
    if (cookie) updates.eraLogoutAt = cookie.state === "live" ? cookie.logoutAt : null;
    await commitStatus(state, next, at, updates);
    after = next.status;
  }
  entries.push({
    type: "no-tabs",
    at: at,
    from: priorStatus,
    to: after,
    cookie: cookie ? cookie.state : null,
    minsLeft: cookie ? matcher.roundMinutes(cookie.minsLeft) : null
  });
  await appendDiagnosticEntries(entries);
  await chrome.alarms.clear(ALARM_NAME);
}

function nudgeEraTabs(alarm) {
  return serialized(function () { return runTick(alarm); });
}

async function runTick(alarm) {
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

    var probes = await probeTabs(tabs);
    if (state.sessionStatus === "idle") {
      var probed = probes.map(function (probe) { return probe.result; });
      state = await resolveIdle(state, at, {
        cookie: await readEraCookie(at),
        tabsOpen: true,
        loginPage: probed.some(function (result) { return result.isLoginPage; }),
        livePage: probed.some(function (result) { return matcher.classifyTabResult(result, "idle") === "active"; })
      });
    }

    // One server ping per alarm per keep-alive URL, from one active tab.
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
    await applyResults(results, at, { nudged: true, cookie: await readEraCookie(Date.now()) });
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

  if (state.sessionStatus === "idle") {
    state = await resolveIdle(state, at, {
      cookie: await readEraCookie(Date.now()),
      tabsOpen: true,
      loginPage: result.isLoginPage,
      livePage: matcher.classifyTabResult(result, "idle") === "active",
      path: result.path
    });
  }
  var classification = matcher.classifyTabResult(result, state.sessionStatus);
  if (classification === "active") {
    await applyResults([result], at);
  } else if (classification === "ended") {
    // Judge by every open eRA tab and the cookie, as an alarm would, but
    // trust this page's own report for its tab: it may already have left eRA.
    var others = (await probeTabs(await queryEraTabs())).map(function (probe) { return probe.result; })
      .filter(function (other) { return result.tabId === null || other.tabId !== result.tabId; });
    await applyResults([result].concat(others), at, { cookie: await readEraCookie(Date.now()) });
  }
  if (!result.isLoginPage) await configureAlarm();
}

// A cookie event is only a trigger: the cookie is read again from Chrome
// inside the queue, so a removal that was immediately replaced ends nothing.
async function handleCookieChange(change) {
  var state = await getState();
  if (!state.enabled) return;
  var at = Date.now();
  var cookie = await readEraCookie(at);
  if (!cookie) return;
  if (state.sessionStatus === "idle") {
    await resolveIdle(state, at, { cookie: cookie, tabsOpen: (await queryEraTabs()).length > 0 });
    return;
  }
  if (cookie.state === "live") {
    if (change.kind !== "live") return;
    if (state.sessionStatus !== "logged-in") {
      await commitStatus(state, { status: "logged-in", reason: "eRA timer cookie set", path: null }, at,
        { eraLogoutAt: cookie.logoutAt });
    } else if (typeof state.eraLogoutAt !== "number" ||
      Math.abs(cookie.logoutAt - state.eraLogoutAt) >= LOGOUT_AT_STEP_MS) {
      await setState({ eraLogoutAt: cookie.logoutAt });
      await updateBadge();
    }
    return;
  }
  if (change.kind !== "ended" || state.sessionStatus === "logged-out") return;
  await commitStatus(state, {
    status: "logged-out",
    reason: cookie.state === "expired" ? "eRA timer cookie expired" : change.reason,
    path: null
  }, at, {});
}

// eRA rewrites the cookie on every bit of activity, so a burst of "live"
// events shares one queued check.
function onCookieChanged(changeInfo) {
  var change = matcher.classifyCookieChange(changeInfo, Date.now());
  if (change.kind === "ignore") return Promise.resolve();
  if (change.kind === "live") {
    if (cookieLiveCheckQueued) return Promise.resolve();
    cookieLiveCheckQueued = true;
  }
  return serialized(function () {
    if (change.kind === "live") cookieLiveCheckQueued = false;
    return handleCookieChange(change);
  }).catch(function (error) {
    console.warn("eRA Keep Alive: could not handle a cookie change", error);
  });
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
  if (message.type === "era-page-ready") {
    return serialized(function () { return handlePageReady(message, sender); });
  }
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

// Chrome drops eRA's cookie when it quits (it has no expiry), so after a
// restart a session last seen live or idle is judged like a return from idle.
async function resolveAfterRestart() {
  var state = await getState();
  if (!state.enabled || (state.sessionStatus !== "idle" && state.sessionStatus !== "logged-in")) return;
  var at = Date.now();
  var cookie = await readEraCookie(at);
  if (!cookie) return;
  await resolveIdle(state, at, { cookie: cookie, tabsOpen: (await queryEraTabs()).length > 0 });
}

// eRA's server ends sessions it has not heard from in about an hour even
// while its page timer is kept alive, so the server ping is on by default.
// An update from before 1.4.3 turns it on once; pingDefaultOnApplied makes
// sure a later choice to turn it off is never overridden.
function installDefaults(stored, details) {
  details = details || {};
  var fill = {};
  if (typeof stored.enabled !== "boolean") fill.enabled = true;
  if (typeof stored.pingServer !== "boolean") fill.pingServer = true;
  if (!stored.pingDefaultOnApplied) {
    if (details.reason === "install" ||
      (details.reason === "update" && matcher.isVersionBefore(details.previousVersion, PING_DEFAULT_ON_VERSION))) {
      fill.pingServer = true;
    }
    fill.pingDefaultOnApplied = true;
  }
  return fill;
}

async function startUp(defaultsToFill, details) {
  if (!defaultsToFill) await serialized(resolveAfterRestart);
  if (defaultsToFill) {
    var stored = await chrome.storage.local.get(["enabled", "pingServer", "pingDefaultOnApplied"]);
    var fill = installDefaults(stored, details);
    if (Object.keys(fill).length) await setState(fill);
  }
  await injectIntoOpenTabs();
  await configureAlarm();
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(function (details) {
  startUp(true, details).catch(function (error) { console.warn("eRA Keep Alive: install setup failed", error); });
});

chrome.runtime.onStartup.addListener(function () {
  startUp(false).catch(function (error) { console.warn("eRA Keep Alive: startup failed", error); });
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name !== ALARM_NAME) return;
  nudgeEraTabs(alarm).catch(function (error) {
    console.warn("eRA Keep Alive: nudge failed", error);
  });
});

chrome.runtime.onMessage.addListener(function (message, sender) {
  handleMessage(message, sender).catch(function (error) {
    console.warn("eRA Keep Alive: message handling failed", error);
  });
});

chrome.cookies.onChanged.addListener(onCookieChanged);

chrome.notifications.onClicked.addListener(function (notificationId) {
  if (notificationId !== "era-session-ended") return;
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") }).catch(function (error) {
    console.warn("eRA Keep Alive: could not open the popup tab", error);
  });
  chrome.notifications.clear(notificationId).catch(function () {});
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local" || !changes.enabled) return;
  serialized(function () { return handleEnabledChange(changes.enabled.newValue); }).catch(function (error) {
    console.warn("eRA Keep Alive: could not apply the on/off switch", error);
  });
});

// The service worker may not be fully started the moment this file first
// runs (e.g. right after a reload), so the very first chrome.action call can
// reject with "No SW". updateBadge() already swallows that; retry once
// shortly after, once the worker is certainly up, so the badge still ends
// up correct.
updateBadge().catch(function () {});
setTimeout(function () {
  updateBadge().catch(function () {});
}, 1000);
