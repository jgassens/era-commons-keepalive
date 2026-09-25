"use strict";

var defaults = {
  enabled: true,
  sessionStatus: "unknown",
  lastSuccessfulPingAt: null,
  lastAutoClick: null,
  logoutRecords: []
};
var enabled = document.getElementById("enabled");

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : "Never";
}

function formatShortTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatMinutes(minutes, fallback) {
  if (minutes === null || typeof minutes === "undefined") return fallback;
  return minutes + " min";
}

function hasRecentPing(record) {
  return record.lastSuccessfulPingAt !== null &&
    record.loggedOutDetectedAt - record.lastSuccessfulPingAt < 5 * 60 * 1000;
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
    item.textContent = "Logged out " + formatShortTime(record.loggedOutDetectedAt) + " — " +
      formatMinutes(record.minutesSinceLastPing, "no successful check recorded") +
      " after last check, " +
      formatMinutes(record.minutesSinceLastPageLoad, "page-load time unavailable") +
      " after you last loaded a page";
    container.appendChild(item);
    if (hasRecentPing(record)) {
      var warning = document.createElement("li");
      warning.className = "logout-warning";
      warning.textContent = "eRA ended this session despite recent activity - it may have a hard time limit or the check is not counting as activity.";
      container.appendChild(warning);
    }
  });
}

function render(state) {
  enabled.checked = state.enabled;
  document.getElementById("status").textContent = !state.enabled ? "Disabled" :
    state.sessionStatus === "logged-in" ? "Enabled — logged in" :
    state.sessionStatus === "logged-out" ? "Enabled — logged out" : "Enabled — status unknown";
  document.getElementById("last-ping").textContent = formatTime(state.lastSuccessfulPingAt);
  document.getElementById("last-click").textContent = formatTime(state.lastAutoClick);
  renderLogoutRecords(state.logoutRecords || []);
}

chrome.storage.local.get(defaults).then(render);
enabled.addEventListener("change", function () {
  chrome.storage.local.set({ enabled: enabled.checked });
});
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local") chrome.storage.local.get(defaults).then(render);
});
