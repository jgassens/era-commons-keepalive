"use strict";

var defaults = { enabled: true, sessionStatus: "unknown", lastSuccessfulPing: null, lastAutoClick: null };
var enabled = document.getElementById("enabled");

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : "Never";
}

function render(state) {
  enabled.checked = state.enabled;
  document.getElementById("status").textContent = !state.enabled ? "Disabled" :
    state.sessionStatus === "logged-in" ? "Enabled — logged in" :
    state.sessionStatus === "logged-out" ? "Enabled — logged out" : "Enabled — status unknown";
  document.getElementById("last-ping").textContent = formatTime(state.lastSuccessfulPing);
  document.getElementById("last-click").textContent = formatTime(state.lastAutoClick);
}

chrome.storage.local.get(defaults).then(render);
enabled.addEventListener("change", function () {
  chrome.storage.local.set({ enabled: enabled.checked });
});
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local") chrome.storage.local.get(defaults).then(render);
});
