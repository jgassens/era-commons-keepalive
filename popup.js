"use strict";

var defaults = {
  enabled: true,
  pingServer: false,
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
document.getElementById("version").textContent = "Version " + chrome.runtime.getManifest().version;

function minutesText(minutes, fallback) {
  return matcher.formatMinutes(minutes) || fallback;
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
    var server = record.lastServerPing ||
      (typeof record.lastServerPingStatus === "number" ? "server " + record.lastServerPingStatus : null) ||
      (record.pingServer ? "no server ping recorded" : "server not called (ping off)");
    var when = typeof record.estimatedEndAt === "number" ?
      "probably ended around " + matcher.formatTime(record.estimatedEndAt) + ", noticed " +
        matcher.formatTime(record.loggedOutDetectedAt) :
      matcher.formatTime(record.loggedOutDetectedAt);
    item.textContent = "Logged out " + when +
      (record.reason ? " (" + record.reason + ")" : "") + " — " +
      minutesText(record.minutesSinceSignIn, "unknown time") + " after sign-in, " +
      minutesText(record.minutesSinceLastNudge, "no activity nudge recorded") +
      " after last activity nudge, " +
      minutesText(record.minutesSinceLastPageLoad, "page-load time unavailable") +
      " after you last loaded a page; eRA timer at last nudge: " +
      minutesText(record.minutesLeftAtLastNudge, "unavailable") + "; " + server;
    container.appendChild(item);
    var note = matcher.logoutNote(record);
    if (note) {
      var warning = document.createElement("li");
      warning.className = "logout-warning";
      warning.textContent = note;
      container.appendChild(warning);
    }
  });
}

function renderDiagnosticLog(entries) {
  currentLog = entries || [];
  var container = document.getElementById("diagnostic-log");
  container.textContent = "";
  if (!currentLog.length) {
    container.textContent = "No diagnostic entries yet.";
    return;
  }
  currentLog.slice(-30).reverse().forEach(function (entry) {
    var line = document.createElement("div");
    line.textContent = matcher.formatLogLine(entry);
    container.appendChild(line);
  });
}

function render(state) {
  enabled.checked = state.enabled;
  pingServer.checked = state.pingServer;
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
  var serverWarning = document.getElementById("server-warning");
  var showWarning = state.enabled && state.sessionStatus === "logged-in" && !!state.serverWarning;
  serverWarning.hidden = !showWarning;
  serverWarning.textContent = showWarning ? "eRA's server rejected the keep-alive (redirect) at " +
    matcher.formatTime(state.serverWarning.at) + ", but eRA's timer is still live, so the extension keeps nudging." : "";
  renderLogoutRecords(state.logoutRecords || []);
  renderDiagnosticLog(state.diagnosticLog || []);
}

chrome.storage.local.get(defaults).then(render);
enabled.addEventListener("change", function () {
  chrome.storage.local.set({ enabled: enabled.checked });
});
pingServer.addEventListener("change", function () {
  chrome.storage.local.set({ pingServer: pingServer.checked });
});
document.getElementById("copy-log").addEventListener("click", async function (event) {
  var button = event.currentTarget;
  var text = currentLog.map(matcher.formatLogLine).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch (error) {
    button.textContent = "Copy failed";
  }
  window.setTimeout(function () { button.textContent = "Copy log"; }, 1500);
});
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local") chrome.storage.local.get(defaults).then(render);
});
