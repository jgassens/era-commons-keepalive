"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

test("manifest is MV3; the recorder's permissions are optional, never required", function () {
  var manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.name, "Session Keeper for eRA Commons (unofficial)");
  assert.deepEqual(manifest.permissions, ["storage", "alarms", "notifications", "scripting", "cookies"]);
  assert.deepEqual(manifest.host_permissions, ["https://*.era.nih.gov/*"]);
  assert.deepEqual(manifest.optional_permissions, ["webRequest"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*.nih.gov/*", "https://*.login.gov/*"]);
  assert.equal(manifest.permissions.indexOf("unlimitedStorage"), -1);
  assert.equal(manifest.permissions.indexOf("webRequest"), -1);
  assert.equal(manifest.permissions.indexOf("downloads"), -1);
});
