"use strict";

// Generates anti-aliased RGBA PNG toolbar icons using only Node's standard library.
var fs = require("node:fs");
var path = require("node:path");
var zlib = require("node:zlib");

var FACE = [255, 255, 255, 255];
var RING = [21, 128, 61, 255]; // #15803d
var HAND = [20, 83, 45, 255]; // #14532d

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

function circleSdf(x, y, cx, cy, radius) {
  return Math.hypot(x - cx, y - cy) - radius;
}

// Signed distance to a line segment expanded by a radius (a rounded capsule).
function capsuleSdf(x, y, ax, ay, bx, by, radius) {
  var dx = bx - ax;
  var dy = by - ay;
  var lengthSquared = dx * dx + dy * dy;
  var t = lengthSquared ? ((x - ax) * dx + (y - ay) * dy) / lengthSquared : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) - radius;
}

function paint(pixel, color) {
  // Every primitive is opaque; keeping this as source-over makes the draw order explicit.
  var alpha = color[3] / 255;
  pixel[0] = color[0] * alpha + pixel[0] * (1 - alpha);
  pixel[1] = color[1] * alpha + pixel[1] * (1 - alpha);
  pixel[2] = color[2] * alpha + pixel[2] * (1 - alpha);
  pixel[3] = 255 * alpha + pixel[3] * (1 - alpha);
}

function makeIcon(size) {
  var samples = size === 16 ? 8 : 4;
  var sampleCount = samples * samples;
  var center = size * 0.44;
  var diameter = size * 0.80;
  var outerRadius = diameter / 2;
  var ringWidth = Math.max(2, diameter * 0.12);
  var innerRadius = outerRadius - ringWidth;
  var handWidth = Math.max(2, diameter * 0.13);
  var hourLength = diameter * 0.28;
  var minuteLength = diameter * 0.38;
  var pixels = Buffer.alloc((size * 4 + 1) * size);

  // Clock directions in image coordinates: 12 is up and 10 is up-left.
  var hourX = center - hourLength * Math.sin(Math.PI / 3);
  var hourY = center - hourLength * Math.cos(Math.PI / 3);
  var minuteX = center;
  var minuteY = center - minuteLength;

  for (var y = 0; y < size; y++) {
    pixels[y * (size * 4 + 1)] = 0; // PNG's "no filter" marker.
    for (var x = 0; x < size; x++) {
      var total = [0, 0, 0, 0];
      for (var sy = 0; sy < samples; sy++) {
        for (var sx = 0; sx < samples; sx++) {
          var px = x + (sx + 0.5) / samples;
          var py = y + (sy + 0.5) / samples;
          var color = [0, 0, 0, 0];

          // Face, outline ring, and inner face are separate layers for a clean stroke.
          if (circleSdf(px, py, center, center, outerRadius) <= 0) paint(color, FACE);
          if (circleSdf(px, py, center, center, outerRadius) <= 0) paint(color, RING);
          if (circleSdf(px, py, center, center, innerRadius) <= 0) paint(color, FACE);

          if (size >= 48) {
            var tickStart = innerRadius - diameter * 0.045;
            var tickEnd = tickStart - diameter * 0.085;
            var tickRadius = Math.max(1, diameter * 0.026);
            var directions = [[0, -1], [1, 0], [0, 1], [-1, 0]];
            for (var tick = 0; tick < directions.length; tick++) {
              var direction = directions[tick];
              if (capsuleSdf(px, py,
                center + direction[0] * tickStart, center + direction[1] * tickStart,
                center + direction[0] * tickEnd, center + direction[1] * tickEnd,
                tickRadius) <= 0) paint(color, RING);
            }
          }

          if (capsuleSdf(px, py, center, center, hourX, hourY, handWidth / 2) <= 0) paint(color, HAND);
          if (capsuleSdf(px, py, center, center, minuteX, minuteY, handWidth / 2) <= 0) paint(color, HAND);
          if (circleSdf(px, py, center, center, Math.max(1.25, handWidth * 0.60)) <= 0) paint(color, HAND);

          total[0] += color[0]; total[1] += color[1]; total[2] += color[2]; total[3] += color[3];
        }
      }
      var offset = y * (size * 4 + 1) + 1 + x * 4;
      // Samples are accumulated premultiplied; PNG stores straight-alpha RGB.
      pixels[offset] = total[3] ? Math.round(total[0] * 255 / total[3]) : 0;
      pixels[offset + 1] = total[3] ? Math.round(total[1] * 255 / total[3]) : 0;
      pixels[offset + 2] = total[3] ? Math.round(total[2] * 255 / total[3]) : 0;
      pixels[offset + 3] = Math.round(total[3] / sampleCount);
    }
  }

  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8-bit channels
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

var output = path.join(__dirname, "..", "icons");
fs.mkdirSync(output, { recursive: true });
[16, 32, 48, 128].forEach(function (size) {
  fs.writeFileSync(path.join(output, "icon" + size + ".png"), makeIcon(size));
});
