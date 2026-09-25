"use strict";

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
  logoutRecords: []
};

function getState() {
  return chrome.storage.local.get(DEFAULT_STATE);
}

function setState(values) {
  return chrome.storage.local.set(values);
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
  if (!state.enabled || state.sessionStatus === "logged-out") {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: NUDGE_PERIOD_MINUTES });
}

async function markLoggedOut() {
  var prior = await getState();
  var detectedAt = Date.now();
  var updates = { sessionStatus: "logged-out", eraLogoutAt: null };
  if (prior.sessionStatus !== "logged-out") {
    var lastNudgeAt = prior.lastNudgeAt;
    var lastUserPageLoadAt = prior.lastUserPageLoadAt;
    var minutesSinceLastNudge = lastNudgeAt === null ? null :
      Math.max(0, Math.round((detectedAt - lastNudgeAt) / 60000));
    var minutesSinceLastPageLoad = lastUserPageLoadAt === null ? null :
      Math.max(0, Math.round((detectedAt - lastUserPageLoadAt) / 60000));
    var record = {
      loggedOutDetectedAt: detectedAt,
      lastNudgeAt: lastNudgeAt,
      lastUserPageLoadAt: lastUserPageLoadAt,
      minutesSinceLastNudge: minutesSinceLastNudge,
      minutesSinceLastPageLoad: minutesSinceLastPageLoad
    };
    updates.logoutRecords = [record].concat(prior.logoutRecords || []).slice(0, 10);
  }
  await setState(updates);
  await chrome.alarms.clear(ALARM_NAME);
  await updateBadge();
  if (prior.sessionStatus !== "logged-out") {
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
  if (!state.enabled || state.sessionStatus === "logged-out") return;
  var tabs = await chrome.tabs.query(ERA_TAB_QUERY);
  if (!tabs.length) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  var results = await Promise.all(tabs.map(async function (tab) {
    try {
      return await chrome.tabs.sendMessage(tab.id, { type: "nudge-activity" });
    } catch (error) {
      // A tab can close or still be loading; the next alarm retries it.
      return null;
    }
  }));

  if (results.some(function (result) { return result && result.loggedOut; })) {
    await markLoggedOut();
    return;
  }

  var nudges = results.filter(function (result) { return result && result.nudged; });
  if (nudges.length) {
    var now = Date.now();
    var logoutAt = null;
    nudges.forEach(function (result) {
      if (typeof result.logoutAt === "number" && (logoutAt === null || result.logoutAt > logoutAt)) {
        logoutAt = result.logoutAt;
      }
    });
    var updates = { lastNudgeAt: now, eraLogoutAt: logoutAt };
    if (typeof logoutAt === "number" && logoutAt > now + 30 * 60 * 1000) {
      updates.sessionStatus = "logged-in";
    }
    await setState(updates);
    await updateBadge();
  }
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
    console.info("eRA Commons timeout warning continued", new Date(message.at || Date.now()).toISOString());
    setState({ lastAutoClick: message.at || Date.now() });
  }
  if (message.type === "era-page-ready") {
    if (message.isLoginPage) {
      markLoggedOut();
    } else {
      getState().then(async function (state) {
        if (!state.enabled) return;
        await setState({
          sessionStatus: "logged-in",
          lastUserPageLoadAt: message.at || Date.now()
        });
        await configureAlarm();
        await updateBadge();
      });
    }
  }
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local" || !changes.enabled) return;
  (async function () {
    if (!changes.enabled.newValue) {
      await chrome.alarms.clear(ALARM_NAME);
    } else {
      await setState({ sessionStatus: "unknown" });
      await configureAlarm();
    }
    await updateBadge();
  })();
});

updateBadge();
