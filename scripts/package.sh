#!/usr/bin/env bash
# Build dist/session-keeper-era-<version>.zip with only the files the
# extension needs at runtime. macOS-compatible (bash 3.2, no mapfile).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd "$script_dir/.." && pwd)"
cd "$root_dir"

if ! command -v zip >/dev/null 2>&1; then
  echo "error: 'zip' is required but not found on PATH" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' is required but not found on PATH" >&2
  exit 1
fi

version="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("manifest.json","utf8")).version)')"
if [ -z "$version" ]; then
  echo "error: could not read version from manifest.json" >&2
  exit 1
fi

# Discover every runtime file referenced by manifest.json (and, transitively,
# by any HTML page manifest.json points to) instead of hardcoding a list.
files_raw="$(node -e '
var fs = require("fs");
var path = require("path");
var manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
var files = new Set(["manifest.json"]);

if (manifest.background && manifest.background.service_worker) {
  files.add(manifest.background.service_worker);
}
(manifest.content_scripts || []).forEach(function (entry) {
  (entry.js || []).forEach(function (f) { files.add(f); });
  (entry.css || []).forEach(function (f) { files.add(f); });
});
if (manifest.action && manifest.action.default_popup) {
  files.add(manifest.action.default_popup);
}
function addIconSet(icons) {
  if (!icons) return;
  Object.keys(icons).forEach(function (size) { files.add(icons[size]); });
}
addIconSet(manifest.icons);
if (manifest.action) addIconSet(manifest.action.default_icon);

var htmlPages = [];
if (manifest.action && manifest.action.default_popup) htmlPages.push(manifest.action.default_popup);
htmlPages.forEach(function (page) {
  if (!fs.existsSync(page)) return;
  var html = fs.readFileSync(page, "utf8");
  var re = /<(?:script[^>]*\ssrc|link[^>]*\shref)\s*=\s*["\x27]([^"\x27]+)["\x27]/gi;
  var match;
  while ((match = re.exec(html))) {
    var ref = match[1];
    if (/^https?:\/\//i.test(ref) || ref.indexOf("//") === 0) continue;
    files.add(path.posix.normalize(path.posix.join(path.posix.dirname(page), ref)));
  }
});

process.stdout.write(Array.from(files).sort().join("\n"));
')"

files=()
while IFS= read -r line; do
  [ -n "$line" ] && files+=("$line")
done <<< "$files_raw"

missing=0
for f in "${files[@]}"; do
  if [ ! -f "$f" ]; then
    echo "error: referenced runtime file is missing: $f" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  exit 1
fi

dist_dir="$root_dir/dist"
mkdir -p "$dist_dir"
zip_name="session-keeper-era-${version}.zip"
zip_path="$dist_dir/$zip_name"
rm -f "$zip_path"

zip -X -q "$zip_path" "${files[@]}"

echo "Built $zip_path"
echo "Contents:"
unzip -l "$zip_path"
