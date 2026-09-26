/* Pure helpers for the optional diagnostic recorder, shared by the
   background, the popup and Node tests. Nothing here keeps a cookie value,
   a query string, a fragment or a ;jsessionid= path parameter. */
(function (root, factory) {
  var matcher = root.EraKeepAlive || (typeof require === "function" ? require("./matcher.js") : null);
  var api = factory(matcher);
  root.EraRecorder = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (matcher) {
  "use strict";

  // Asked for only when the switch is turned on; see manifest.json.
  var PERMISSIONS = {
    permissions: ["webRequest"],
    origins: ["https://*.nih.gov/*", "https://*.login.gov/*"]
  };
  var URL_FILTER = ["https://*.nih.gov/*", "https://*.login.gov/*"];
  // The recording is an index under RECORDING_KEY plus chunks of at most
  // CHUNK_SIZE events under "recording-<id>". A 2-second batch rewrites only
  // the newest chunk, so no write (or storage.onChanged message to every eRA
  // tab) ever carries the whole recording.
  var RECORDING_KEY = "recording";
  var CHUNK_PREFIX = "recording-";
  var MAX_EVENTS = 20000;
  var CHUNK_SIZE = 500;
  var FLUSH_MS = 2000;
  var PAGE_EVENTS = ["load", "visibilitychange", "pageshow", "pagehide", "modal-shown", "modal-hidden", "navigate"];
  var COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

  function isRecordedHost(host) {
    var h = String(host || "").toLowerCase().replace(/^\.+/, "");
    return h === "nih.gov" || /\.nih\.gov$/.test(h) || h === "login.gov" || /\.login\.gov$/.test(h);
  }

  // Host and path only, resolved against base for a relative Location.
  function safeTarget(url, base) {
    try {
      var parsed = base ? new URL(String(url), String(base)) : new URL(String(url));
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      return { host: parsed.hostname.toLowerCase(), path: matcher.safePath(parsed.href) };
    } catch (error) {
      return null;
    }
  }

  function hostOf(url) {
    var target = safeTarget(url);
    return target ? target.host : null;
  }

  // The origin that started a request, or a label. Never a path or query.
  function initiatorLabel(initiator, extensionOrigin) {
    if (!initiator) return null;
    var value = String(initiator);
    if (extensionOrigin && value === extensionOrigin) return "this-extension";
    if (/^chrome-extension:/i.test(value)) return "other-extension";
    if (value === "null") return "opaque";
    try {
      var parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : parsed.protocol.replace(/:$/, "");
    } catch (error) {
      return "unknown";
    }
  }

  function headerValues(headers, name) {
    var wanted = name.toLowerCase();
    var out = [];
    (Array.isArray(headers) ? headers : []).forEach(function (header) {
      if (!header || String(header.name || "").toLowerCase() !== wanted) return;
      String(header.value || "").split("\n").forEach(function (value) { out.push(value); });
    });
    return out;
  }

  // Only the part before "=" of each Set-Cookie line: the cookie's name.
  function setCookieNames(headers) {
    var names = [];
    headerValues(headers, "set-cookie").forEach(function (line) {
      var eq = line.indexOf("=");
      if (eq <= 0) return;
      var name = line.slice(0, eq).trim();
      if (COOKIE_NAME_PATTERN.test(name) && names.indexOf(name) === -1) names.push(name);
    });
    return names;
  }

  function locationTarget(headers, requestUrl) {
    var value = headerValues(headers, "location")[0];
    return value ? safeTarget(value.trim(), requestUrl) : null;
  }

  // Drops null, undefined and empty lists so 20,000 events stay small.
  function compact(event) {
    Object.keys(event).forEach(function (key) {
      var value = event[key];
      if (value === null || value === undefined || (Array.isArray(value) && !value.length)) delete event[key];
    });
    return event;
  }

  // event: "request" | "redirect" | "completed" | "error". headerInfo is what
  // onHeadersReceived saw for this request: { setCookies, location }.
  function requestEvent(event, details, extensionOrigin, headerInfo, now) {
    details = details || {};
    var target = safeTarget(details.url);
    if (!target || !isRecordedHost(target.host)) return null;
    var initiator = initiatorLabel(details.initiator, extensionOrigin);
    var redirect = event === "redirect" ? safeTarget(details.redirectUrl) : null;
    headerInfo = headerInfo || {};
    return compact({
      t: typeof details.timeStamp === "number" ? Math.round(details.timeStamp) : now,
      event: event,
      requestId: details.requestId != null ? String(details.requestId) : null,
      method: details.method ? String(details.method).toUpperCase().slice(0, 16) : null,
      host: target.host,
      path: target.path,
      type: details.type ? String(details.type) : null,
      tabId: typeof details.tabId === "number" ? details.tabId : null,
      frameId: typeof details.frameId === "number" && details.frameId !== 0 ? details.frameId : null,
      initiator: initiator,
      ext: initiator === "this-extension" ? true : null,
      statusCode: event !== "request" && typeof details.statusCode === "number" ? details.statusCode : null,
      redirectHost: redirect ? redirect.host : (headerInfo.location ? headerInfo.location.host : null),
      redirectPath: redirect ? redirect.path : (headerInfo.location ? headerInfo.location.path : null),
      error: event === "error" && details.error ? String(details.error).slice(0, 100) : null,
      fromCache: event !== "request" && details.fromCache ? true : null,
      setCookies: headerInfo.setCookies || null
    });
  }

  function isRecordedCookie(changeInfo) {
    return !!(changeInfo && changeInfo.cookie && isRecordedHost(changeInfo.cookie.domain));
  }

  // fingerprint: { fp, len } computed from the value by fingerprintValue().
  function cookieEvent(changeInfo, fingerprint, now) {
    var cookie = changeInfo.cookie;
    var event = {
      t: now,
      event: "cookie",
      name: String(cookie.name || ""),
      domain: String(cookie.domain || ""),
      path: String(cookie.path || "/").split(/[?#;]/)[0],
      cause: changeInfo.cause ? String(changeInfo.cause) : null,
      removed: !!changeInfo.removed,
      session: cookie.session ? true : null,
      expirationDate: !cookie.session && typeof cookie.expirationDate === "number" ? cookie.expirationDate : null,
      httpOnly: !!cookie.httpOnly,
      secure: !!cookie.secure,
      sameSite: cookie.sameSite ? String(cookie.sameSite) : null,
      fp: fingerprint && fingerprint.fp ? fingerprint.fp : null,
      len: fingerprint && typeof fingerprint.len === "number" ? fingerprint.len : null
    };
    return compact(event);
  }

  function hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (byte) {
      return (byte < 16 ? "0" : "") + byte.toString(16);
    }).join("");
  }

  // The first 6 hex digits of SHA-256(salt + value), and the value's length.
  // Equal fingerprints mean "probably the same value"; the salt stays in this
  // browser and never goes into the download, so short values such as a
  // timestamp cannot be recovered from the file by trying every guess.
  async function fingerprintValue(value, salt, subtle) {
    var text = String(value == null ? "" : value);
    if (!subtle || typeof TextEncoder !== "function") return { fp: null, len: text.length };
    try {
      var digest = await subtle.digest("SHA-256", new TextEncoder().encode(String(salt || "") + "\u0000" + text));
      return { fp: hex(digest).slice(0, 6), len: text.length };
    } catch (error) {
      return { fp: null, len: text.length };
    }
  }

  // A page event reported by content.js on an eRA page.
  function pageEvent(message, senderUrl, tabId, now) {
    if (!message || PAGE_EVENTS.indexOf(message.what) === -1) return null;
    var host = hostOf(senderUrl);
    if (!host || !isRecordedHost(host)) return null;
    return compact({
      t: typeof message.at === "number" ? message.at : now,
      event: "page",
      what: message.what,
      host: host,
      path: matcher.safePath(message.path || senderUrl),
      fromPath: message.fromPath ? matcher.safePath(message.fromPath) : null,
      tabId: typeof tabId === "number" ? tabId : null,
      visibility: message.visibility === "visible" || message.visibility === "hidden" ? message.visibility : null,
      persisted: typeof message.persisted === "boolean" ? message.persisted : null,
      modal: message.modal ? String(message.modal).slice(0, 64) : null
    });
  }

  // Diagnostic-log entries that mark session boundaries. Their fields are
  // already safe (paths went through safePath); only `type`/`at` are renamed.
  var SESSION_TYPES = ["status", "server-refused", "server-recheck-retry", "server-recheck-deferred", "no-tabs", "auto-click"];
  function sessionEvent(entry) {
    if (!entry || typeof entry !== "object") return null;
    var mirrored = SESSION_TYPES.indexOf(entry.type) !== -1 || (entry.type === "nudge" && entry.serverCalled);
    if (!mirrored) return null;
    var event = { t: entry.at, event: "session", what: entry.type };
    Object.keys(entry).forEach(function (key) {
      if (key !== "type" && key !== "at") event[key] = entry[key];
    });
    if (event.path) event.path = matcher.safePath(event.path);
    return compact(event);
  }

  function listFrom(value) {
    return Array.isArray(value) ? value : [];
  }

  function chunkKey(id) {
    return CHUNK_PREFIX + id;
  }

  function normalizeIndex(value) {
    var index = value && typeof value === "object" ? value : {};
    var chunks = listFrom(index.chunks).filter(function (chunk) {
      return chunk && typeof chunk.id === "number" && typeof chunk.n === "number";
    }).map(function (chunk) { return { id: chunk.id, n: chunk.n }; });
    var count = chunks.reduce(function (sum, chunk) { return sum + chunk.n; }, 0);
    var next = typeof index.next === "number" ? index.next : 0;
    chunks.forEach(function (chunk) { if (chunk.id >= next) next = chunk.id + 1; });
    return {
      count: count,
      next: next,
      chunks: chunks,
      dropped: typeof index.dropped === "number" ? index.dropped : 0
    };
  }

  // Appends events to the rolling buffer in one storage.set, then removes
  // the oldest chunks once there are more than max events. A write refused
  // for quota drops the oldest quarter of the recording and tries once more.
  async function appendToRecording(storage, events, limits) {
    limits = limits || {};
    var max = limits.max || MAX_EVENTS;
    var size = limits.chunkSize || CHUNK_SIZE;
    events = listFrom(events).filter(Boolean);
    if (!events.length) return normalizeIndex((await storage.get(RECORDING_KEY))[RECORDING_KEY]);

    var index = normalizeIndex((await storage.get(RECORDING_KEY))[RECORDING_KEY]);
    var writes = {};
    var current = index.chunks[index.chunks.length - 1];
    var tail = [];
    if (current) {
      var key = chunkKey(current.id);
      tail = listFrom((await storage.get(key))[key]).slice(0, current.n);
    }
    function openChunk() {
      current = { id: index.next, n: 0 };
      index.next += 1;
      index.chunks.push(current);
      tail = [];
    }
    if (!current || tail.length >= size) openChunk();
    events.forEach(function (event) {
      if (tail.length >= size) {
        writes[chunkKey(current.id)] = tail;
        openChunk();
      }
      tail.push(event);
      current.n = tail.length;
    });
    writes[chunkKey(current.id)] = tail;

    var removed = [];
    function dropOldest() {
      var oldest = index.chunks.shift();
      index.dropped += oldest.n;
      var oldKey = chunkKey(oldest.id);
      if (oldKey in writes) delete writes[oldKey];
      else removed.push(oldKey);
    }
    function recount() {
      index.count = index.chunks.reduce(function (sum, chunk) { return sum + chunk.n; }, 0);
    }
    recount();
    while (index.count > max && index.chunks.length > 1) {
      dropOldest();
      recount();
    }

    writes[RECORDING_KEY] = index;
    try {
      await storage.set(writes);
    } catch (error) {
      if (index.chunks.length < 2) throw error;
      var drop = Math.max(1, Math.floor(index.chunks.length / 4));
      for (var i = 0; i < drop && index.chunks.length > 1; i += 1) dropOldest();
      recount();
      writes[RECORDING_KEY] = index;
      if (removed.length) await storage.remove(removed);
      removed = [];
      await storage.set(writes);
    }
    if (removed.length) await storage.remove(removed);
    return index;
  }

  async function readRecording(storage) {
    var index = normalizeIndex((await storage.get(RECORDING_KEY))[RECORDING_KEY]);
    var keys = index.chunks.map(function (chunk) { return chunkKey(chunk.id); });
    var stored = keys.length ? await storage.get(keys) : {};
    var events = [];
    keys.forEach(function (key) { events = events.concat(listFrom(stored[key])); });
    return { index: index, events: events };
  }

  // Every chunk key, including any a write left behind, plus the index.
  async function clearRecording(storage) {
    var all = await storage.get(null);
    var keys = Object.keys(all || {}).filter(function (key) {
      return key === RECORDING_KEY || key.indexOf(CHUNK_PREFIX) === 0;
    });
    if (keys.length) await storage.remove(keys);
  }

  function recordingCount(value) {
    return normalizeIndex(value).count;
  }

  // The downloaded file.
  function exportRecording(recording, info) {
    info = info || {};
    return {
      format: "era-session-keeper-recording",
      formatVersion: 1,
      extensionVersion: info.extensionVersion || null,
      exportedAt: typeof info.exportedAt === "number" ? new Date(info.exportedAt).toISOString() : null,
      count: recording.events.length,
      droppedOldest: recording.index.dropped,
      note: "Times (t) are milliseconds since 1970 UTC. Cookie values, query strings and page contents are never recorded; fp is a salted 6-hex fingerprint of a cookie value.",
      events: recording.events
    };
  }

  function exportFileName(at) {
    var d = new Date(at);
    function two(n) { return (n < 10 ? "0" : "") + n; }
    return "era-recording-" + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + "-" +
      two(d.getHours()) + two(d.getMinutes()) + ".json";
  }

  return {
    PERMISSIONS: PERMISSIONS,
    URL_FILTER: URL_FILTER,
    RECORDING_KEY: RECORDING_KEY,
    CHUNK_PREFIX: CHUNK_PREFIX,
    MAX_EVENTS: MAX_EVENTS,
    CHUNK_SIZE: CHUNK_SIZE,
    FLUSH_MS: FLUSH_MS,
    PAGE_EVENTS: PAGE_EVENTS,
    isRecordedHost: isRecordedHost,
    safeTarget: safeTarget,
    initiatorLabel: initiatorLabel,
    setCookieNames: setCookieNames,
    locationTarget: locationTarget,
    requestEvent: requestEvent,
    isRecordedCookie: isRecordedCookie,
    cookieEvent: cookieEvent,
    fingerprintValue: fingerprintValue,
    pageEvent: pageEvent,
    sessionEvent: sessionEvent,
    appendToRecording: appendToRecording,
    readRecording: readRecording,
    clearRecording: clearRecording,
    recordingCount: recordingCount,
    exportRecording: exportRecording,
    exportFileName: exportFileName
  };
});
