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
  serverEndedAt: null,
  lastServerAcceptedAt: null,
  firstRefusalAt: null,
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

// Shows a dl row only when there is a value to show; otherwise hides both
// its dt and dd, so no row ever prints "Never" or "Not signed in".
function detailRow(dtId, ddId, value) {
  var dt = document.getElementById(dtId);
  var dd = document.getElementById(ddId);
  var show = value !== null && typeof value !== "undefined" && value !== "";
  if (dt) dt.hidden = !show;
  if (dd) dd.hidden = !show;
  if (dd && show) dd.textContent = value;
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

function renderLogoutCard(record) {
  var card = document.createElement("div");
  card.className = "logout-card";

  var headline = document.createElement("p");
  headline.className = "logout-headline";
  try {
    headline.textContent = matcher.logoutHeadline(record);
  } catch (error) {
    headline.textContent = "Logged out (this record could not be read)";
    card.appendChild(headline);
    return card;
  }
  card.appendChild(headline);

  var summaryLine = null;
  var note = null;
  var facts = [];
  try { summaryLine = matcher.logoutSummaryLine(record); } catch (error) { summaryLine = null; }
  try { note = matcher.logoutNote(record); } catch (error) { note = null; }
  try { facts = matcher.logoutDetailFacts(record); } catch (error) { facts = []; }

  if (summaryLine) {
    var summaryEl = document.createElement("p");
    summaryEl.className = "logout-summary";
    summaryEl.textContent = summaryLine;
    card.appendChild(summaryEl);
  }
  if (note) {
    var noteEl = document.createElement("p");
    noteEl.className = "logout-note";
    noteEl.textContent = note;
    card.appendChild(noteEl);
  }
  if (facts.length) {
    var moreDetails = document.createElement("details");
    moreDetails.className = "logout-more";
    var summaryTag = document.createElement("summary");
    summaryTag.textContent = "More";
    moreDetails.appendChild(summaryTag);
    var factsEl = document.createElement("p");
    factsEl.className = "logout-facts";
    factsEl.textContent = facts.join(" · ");
    moreDetails.appendChild(factsEl);
    card.appendChild(moreDetails);
  }
  return card;
}

function renderLogoutRecords(records) {
  var container = document.getElementById("logout-records");
  container.textContent = "";
  if (!records.length) {
    var empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No logged-out sessions detected yet.";
    container.appendChild(empty);
    return;
  }
  records.forEach(function (record) {
    container.appendChild(renderLogoutCard(record));
  });
}

// The server-end sentence belongs only to the end serverEndedAt marks: the
// latest record must be that end, noticed at that same moment.
function currentServerEnd(state) {
  var latest = listFrom(state.logoutRecords)[0];
  return isNumber(state.serverEndedAt) && matcher.isServerEndRecord(latest) &&
    latest.loggedOutDetectedAt === state.serverEndedAt ? latest : null;
}

function renderStatus(state) {
  var serverEnd = currentServerEnd(state);
  var pattern = matcher.sessionEndPattern(listFrom(state.logoutRecords));
  var status = matcher.popupStatus(state, serverEnd, pattern);
  var block = document.getElementById("status-block");
  block.classList.remove("tone-ok", "tone-bad", "tone-neutral");
  block.classList.add("tone-" + status.tone);
  document.getElementById("status").textContent = status.text;
  var subtext = document.getElementById("status-subtext");
  if (subtext) {
    subtext.hidden = !status.subtext;
    subtext.textContent = status.subtext || "";
  }
}

function renderDetails(state) {
  detailRow("dt-signed-in", "signed-in",
    (state.sessionStatus === "logged-in" || state.sessionStatus === "idle") && isNumber(state.sessionStartedAt) ?
      matcher.formatTime(state.sessionStartedAt) : null);
  detailRow("dt-last-nudge", "last-nudge", isNumber(state.lastNudgeAt) ? matcher.formatTime(state.lastNudgeAt) : null);
  detailRow("dt-server-checkin", "server-checkin", matcher.serverCheckInStatus(state));
  detailRow("dt-last-click", "last-click", isNumber(state.lastAutoClick) ? matcher.formatTime(state.lastAutoClick) : null);
}

// Shown once two server-ended sessions lasted about as long as each other.
// While signed in, the same sentence already rides under the green status,
// so this standalone line stays hidden then to avoid saying it twice.
function renderSessionPattern(state, records) {
  var pattern = document.getElementById("session-pattern");
  var sentence = matcher.sessionEndPattern(records);
  var show = !!sentence && state.sessionStatus !== "logged-in";
  pattern.hidden = !show;
  pattern.textContent = show ? sentence : "";
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
  section("details", function () { renderDetails(state); });
  section("session-pattern", function () { renderSessionPattern(state, listFrom(state.logoutRecords)); });
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
