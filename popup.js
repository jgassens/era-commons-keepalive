"use strict";

var defaults = {
  enabled: true,
  pingServer: true,
  sessionStatus: "unknown",
  sessionStartedAt: null,
  lastNudgeAt: null,
  eraLogoutAt: null,
  lastAutoClick: null,
  serverWarning: null,
  logoutRecords: [],
  diagnosticLog: []
};
var enabled = document.getElementById("enabled");
var pingServer = document.getElementById("ping-server");
var matcher = globalThis.EraKeepAlive;
var currentLog = [];

// Each part of the popup is drawn on its own, so one bad stored value can
// only blank that part, never the whole popup.
function section(id, draw) {
  try {
    draw();
  } catch (error) {
    console.warn("eRA Keep Alive: could not show " + id, error);
    var container = document.getElementById(id);
    if (container) container.textContent = "Could not show this part (" + String(error && error.message || error) + ").";
  }
}

function listFrom(value) {
  return Array.isArray(value) ? value : [];
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// One line per logout. Records from older versions lack some fields; only
// the facts a record actually holds are shown.
function describeLogoutRecord(record) {
  record = record && typeof record === "object" ? record : {};
  var when = isNumber(record.loggedOutDetectedAt) ? matcher.formatTime(record.loggedOutDetectedAt) : "at an unknown time";
  if (isNumber(record.estimatedEndAt)) {
    when = "probably ended around " + matcher.formatTime(record.estimatedEndAt) + ", noticed " + when;
  }
  var facts = [];
  if (isNumber(record.minutesSinceSignIn)) facts.push(matcher.formatMinutes(record.minutesSinceSignIn) + " after sign-in");
  if (isNumber(record.minutesSinceLastNudge)) {
    facts.push(matcher.formatMinutes(record.minutesSinceLastNudge) + " after last activity nudge");
  }
  if (isNumber(record.minutesSinceLastPageLoad)) {
    facts.push(matcher.formatMinutes(record.minutesSinceLastPageLoad) + " after you last loaded a page");
  }
  if (isNumber(record.minutesLeftAtLastNudge)) {
    facts.push("eRA timer at last nudge: " + matcher.formatMinutes(record.minutesLeftAtLastNudge));
  }
  var server = typeof record.lastServerPing === "string" && record.lastServerPing ? record.lastServerPing :
    isNumber(record.lastServerPingStatus) ? "server " + record.lastServerPingStatus :
    typeof record.pingServer === "boolean" ? (record.pingServer ? "no server ping recorded" : "server not called (ping off)") :
    // Versions before 1.3 pinged on every check and kept only its timing.
    isNumber(record.minutesSinceLastPing) ? "last server ping " + matcher.formatMinutes(record.minutesSinceLastPing) + " earlier" : null;
  if (server) facts.push(server);
  return "Logged out " + when + (record.reason ? " (" + String(record.reason) + ")" : "") +
    (facts.length ? " — " + facts.join("; ") : "");
}

function renderLogoutRecords(records) {
  var container = document.getElementById("logout-records");
  container.textContent = "";
  if (!records.length) {
    container.textContent = "No logged-out sessions detected yet.";
    return;
  }
  records.forEach(function (record) {
    var item = document.createElement("li");
    var note = null;
    try {
      item.textContent = describeLogoutRecord(record);
      note = matcher.logoutNote(record);
    } catch (error) {
      item.textContent = "Logged out (this record could not be read)";
    }
    container.appendChild(item);
    if (note) {
      var warning = document.createElement("li");
      warning.className = "logout-warning";
      warning.textContent = note;
      container.appendChild(warning);
    }
  });
}

function logLine(entry) {
  try {
    return matcher.formatLogLine(entry && typeof entry === "object" ? entry : {});
  } catch (error) {
    return "(unreadable log entry)";
  }
}

function renderDiagnosticLog(entries) {
  currentLog = entries;
  var container = document.getElementById("diagnostic-log");
  container.textContent = "";
  if (!currentLog.length) {
    container.textContent = "No diagnostic entries yet.";
    return;
  }
  currentLog.slice(-30).reverse().forEach(function (entry) {
    var line = document.createElement("div");
    line.textContent = logLine(entry);
    container.appendChild(line);
  });
}

function renderStatus(state) {
  document.getElementById("status").textContent = !state.enabled ? "Disabled" :
    state.sessionStatus === "logged-in" ? "Enabled — logged in" :
    state.sessionStatus === "logged-out" ? "Enabled — logged out" :
    state.sessionStatus === "idle" ? "No eRA tab open — not keeping the session alive" : "Enabled — status unknown";
  document.getElementById("signed-in").textContent =
    state.sessionStatus === "logged-in" || state.sessionStatus === "idle" ?
      matcher.formatTime(state.sessionStartedAt) : "Not signed in";
  document.getElementById("last-nudge").textContent = matcher.formatTime(state.lastNudgeAt);
  document.getElementById("logout-at").textContent = matcher.formatTime(state.eraLogoutAt);
  document.getElementById("last-click").textContent = matcher.formatTime(state.lastAutoClick);
}

function renderServerWarning(state) {
  var serverWarning = document.getElementById("server-warning");
  var warning = state.serverWarning && typeof state.serverWarning === "object" ? state.serverWarning : null;
  var showWarning = !!state.enabled && state.sessionStatus === "logged-in" && !!warning;
  serverWarning.hidden = !showWarning;
  serverWarning.textContent = showWarning ? "eRA's server rejected the keep-alive (redirect) at " +
    matcher.formatTime(warning.at) + ", but eRA's timer is still live, so the extension keeps nudging." : "";
}

function render(state) {
  state = state && typeof state === "object" ? state : defaults;
  section("version", function () {
    document.getElementById("version").textContent = "Version " + chrome.runtime.getManifest().version;
  });
  section("controls", function () {
    enabled.checked = state.enabled !== false;
    pingServer.checked = state.pingServer !== false;
  });
  section("status", function () { renderStatus(state); });
  section("server-warning", function () { renderServerWarning(state); });
  section("logout-records", function () { renderLogoutRecords(listFrom(state.logoutRecords)); });
  section("diagnostic-log", function () { renderDiagnosticLog(listFrom(state.diagnosticLog)); });
}

function load() {
  return chrome.storage.local.get(defaults).then(render, function (error) {
    console.warn("eRA Keep Alive: could not read settings", error);
    render(defaults);
  });
}

load();
document.getElementById("open-tab").addEventListener("click", function (event) {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") }).catch(function (error) {
    console.warn("eRA Keep Alive: could not open a tab", error);
  });
});
enabled.addEventListener("change", function () {
  chrome.storage.local.set({ enabled: enabled.checked });
});
pingServer.addEventListener("change", function () {
  chrome.storage.local.set({ pingServer: pingServer.checked });
});
document.getElementById("copy-log").addEventListener("click", async function (event) {
  var button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(currentLog.map(logLine).join("\n"));
    button.textContent = "Copied";
  } catch (error) {
    button.textContent = "Copy failed";
  }
  window.setTimeout(function () { button.textContent = "Copy log"; }, 1500);
});
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local") load();
});
