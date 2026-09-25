"use strict";

// Generates tiny RGBA PNG icons using only Node's standard library.
var fs = require("node:fs");
var path = require("node:path");
var zlib = require("node:zlib");

function crc32(buffer) {
  var crc = 0xffffffff;
  for (var i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (var bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name, data) {
  var type = Buffer.from(name);
  var output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  type.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return output;
}

function makeIcon(size) {
  var pixels = Buffer.alloc((size * 4 + 1) * size);
  var center = (size - 1) / 2;
  var radius = size * 0.43;
  for (var y = 0; y < size; y++) {
    pixels[y * (size * 4 + 1)] = 0;
    for (var x = 0; x < size; x++) {
      var offset = y * (size * 4 + 1) + 1 + x * 4;
      var distance = Math.hypot(x - center, y - center);
      var onClock = distance <= radius;
      var onHand = Math.abs(x - center) < Math.max(1, size / 18) && y < center + size * 0.23 && y > center - size * 0.28;
      var onMinute = y > center + size * 0.13 && x > center - size * 0.05 && x < center + size * 0.30;
      pixels[offset] = onClock ? 21 : 0;
      pixels[offset + 1] = onClock ? 128 : 0;
      pixels[offset + 2] = onClock ? 61 : 0;
      pixels[offset + 3] = onClock ? 255 : 0;
      if (onHand || onMinute) {
        pixels[offset] = 255; pixels[offset + 1] = 255; pixels[offset + 2] = 255; pixels[offset + 3] = 255;
      }
    }
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

var output = path.join(__dirname, "..", "icons");
fs.mkdirSync(output, { recursive: true });
[16, 48, 128].forEach(function (size) {
  fs.writeFileSync(path.join(output, "icon" + size + ".png"), makeIcon(size));
});
