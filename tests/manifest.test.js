"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

test("manifest is MV3 and requests only the required permissions", function () {
  var manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.4.2");
  assert.equal(manifest.name, "Session Keeper for eRA Commons (unofficial)");
  assert.deepEqual(manifest.permissions, ["storage", "alarms", "notifications", "scripting", "cookies"]);
  assert.deepEqual(manifest.host_permissions, ["https://*.era.nih.gov/*"]);
  assert.equal(Object.hasOwn(manifest, "optional_permissions"), false);
  assert.equal(Object.hasOwn(manifest, "optional_host_permissions"), false);
});
