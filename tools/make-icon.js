'use strict';

/**
 * Generates the app icon and the menu bar template icon without any image
 * dependency: raw RGBA is encoded straight into PNG with zlib, then `sips` and
 * `iconutil` build the .icns.
 *
 *   node tools/make-icon.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const OUT = path.join(__dirname, '..', 'assets');
const BUILD = path.join(OUT, 'icon.iconset');

// ---------------------------------------------------------------- png

function crc32 (buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk (type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng (width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- drawing

function createCanvas (size) {
  const data = Buffer.alloc(size * size * 4);
  return {
    size,
    data,
    set (x, y, [r, g, b, a]) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      const offset = (y * size + x) * 4;
      const alpha = a / 255;
      data[offset] = Math.round(r * alpha + data[offset] * (1 - alpha));
      data[offset + 1] = Math.round(g * alpha + data[offset + 1] * (1 - alpha));
      data[offset + 2] = Math.round(b * alpha + data[offset + 2] * (1 - alpha));
      data[offset + 3] = Math.min(255, data[offset + 3] + a);
    },
  };
}

/** Signed distance to a rounded rectangle, used for cheap anti-aliasing. */
function roundedRectDistance (x, y, cx, cy, halfWidth, halfHeight, radius) {
  const dx = Math.abs(x - cx) - (halfWidth - radius);
  const dy = Math.abs(y - cy) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

function fillRoundedRect (canvas, { x, y, width, height, radius, color, samples = 4 }) {
  const step = 1 / samples;
  for (let py = Math.floor(y) - 1; py < y + height + 1; py++) {
    for (let px = Math.floor(x) - 1; px < x + width + 1; px++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const distance = roundedRectDistance(
            px + (sx + 0.5) * step, py + (sy + 0.5) * step,
            x + width / 2, y + height / 2, width / 2, height / 2, radius,
          );
          if (distance <= 0) hits++;
        }
      }
      if (hits > 0) canvas.set(px, py, [...color, Math.round((hits / (samples * samples)) * 255)]);
    }
  }
}

// ---------------------------------------------------------------- artwork

/** The macOS "squircle" approximation used by the app icon. */
function squircleDistance (x, y, size, inset) {
  const centre = size / 2;
  const dx = Math.abs(x - centre) - (centre - inset);
  const dy = Math.abs(y - centre) - (centre - inset);
  const n = 4.2;
  return (Math.pow(Math.pow(dx, n) + Math.pow(dy, n), 1 / n)) - inset * 0.34;
}

function drawAppIcon (size) {
  const canvas = createCanvas(size);
  const inset = size * 0.085;
  const samples = 4;
  const step = 1 / samples;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          if (squircleDistance(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size, inset) <= 0) hits++;
        }
      }
      if (!hits) continue;
      const alpha = hits / (samples * samples);
      // Vertical gradient from graphite to near-black, with a hint of blue.
      const t = y / size;
      const color = [
        Math.round(58 - 34 * t),
        Math.round(60 - 36 * t),
        Math.round(68 - 38 * t),
      ];
      canvas.set(x, y, [...color, Math.round(alpha * 255)]);
    }
  }

  // The island itself, sitting in the middle like the real Dynamic Island.
  const islandWidth = size * 0.56;
  const islandHeight = size * 0.34;
  fillRoundedRect(canvas, {
    x: (size - islandWidth) / 2,
    y: (size - islandHeight) / 2,
    width: islandWidth,
    height: islandHeight,
    radius: islandHeight / 2,
    color: [8, 8, 10],
  });

  // Equaliser bars inside the island.
  const barWidth = size * 0.035;
  const gap = size * 0.028;
  const bars = 4;
  const totalWidth = bars * barWidth + (bars - 1) * gap;
  let x = (size - totalWidth) / 2;
  const palette = [[255, 255, 255], [255, 149, 0], [52, 199, 89], [10, 132, 255]];
  const heights = [0.44, 0.72, 0.56, 0.34];
  for (let index = 0; index < bars; index++) {
    const height = islandHeight * heights[index];
    fillRoundedRect(canvas, {
      x,
      y: (size - height) / 2,
      width: barWidth,
      height,
      radius: barWidth / 2,
      color: palette[index],
    });
    x += barWidth + gap;
  }
  return canvas;
}

/** Menu bar template icon: pure black with an alpha mask, macOS tints it. */
function drawTrayIcon (size) {
  const canvas = createCanvas(size);
  const islandWidth = size * 0.86;
  const islandHeight = size * 0.56;
  fillRoundedRect(canvas, {
    x: (size - islandWidth) / 2,
    y: (size - islandHeight) / 2,
    width: islandWidth,
    height: islandHeight,
    radius: islandHeight / 2,
    color: [0, 0, 0],
  });
  const barWidth = size * 0.07;
  const gap = size * 0.055;
  const heights = [0.3, 0.46, 0.36, 0.24];
  const bars = 4;
  const total = bars * barWidth + (bars - 1) * gap;
  let x = (size - total) / 2;
  for (let index = 0; index < bars; index++) {
    const height = islandHeight * heights[index];
    // Punch the bars out of the pill so the shape reads as a cutout.
    for (let py = Math.floor((size - height) / 2); py < (size + height) / 2; py++) {
      for (let px = Math.floor(x); px < x + barWidth; px++) {
        const radius = barWidth / 2;
        if (roundedRectDistance(px + 0.5, py + 0.5, x + barWidth / 2, (size - height) / 2 + height / 2,
          barWidth / 2, height / 2, radius) <= 0) {
          const offset = (py * size + px) * 4;
          canvas.data[offset] = 255;
          canvas.data[offset + 1] = 255;
          canvas.data[offset + 2] = 255;
          canvas.data[offset + 3] = 0;
        }
      }
    }
    x += barWidth + gap;
  }
  return canvas;
}

// ---------------------------------------------------------------- main

function write (file, canvas) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(canvas.size, canvas.size, canvas.data));
  return file;
}

const appIcon = drawAppIcon(1024);
const master = write(path.join(BUILD, 'icon_512x512@2x.png'), appIcon);
fs.copyFileSync(master, path.join(BUILD, 'icon_512x512.png'));
fs.copyFileSync(master, path.join(BUILD, 'icon_256x256.png'));

execFileSync('sips', ['-z', '16', '16', master, '--out', path.join(BUILD, 'icon_16x16.png')], { stdio: 'ignore' });
execFileSync('sips', ['-z', '32', '32', master, '--out', path.join(BUILD, 'icon_16x16@2x.png')], { stdio: 'ignore' });
execFileSync('sips', ['-z', '32', '32', master, '--out', path.join(BUILD, 'icon_32x32.png')], { stdio: 'ignore' });
execFileSync('sips', ['-z', '64', '64', master, '--out', path.join(BUILD, 'icon_32x32@2x.png')], { stdio: 'ignore' });
execFileSync('sips', ['-z', '128', '128', master, '--out', path.join(BUILD, 'icon_128x128.png')], { stdio: 'ignore' });
execFileSync('sips', ['-z', '256', '256', master, '--out', path.join(BUILD, 'icon_256x256@2x.png')], { stdio: 'ignore' });
execFileSync('sips', ['-z', '512', '512', master, '--out', path.join(BUILD, 'icon_512x512@2x.png')], { stdio: 'ignore' });
execFileSync('iconutil', ['-c', 'icns', BUILD, '-o', path.join(OUT, 'icon.icns')]);

write(path.join(OUT, 'icon.png'), drawAppIcon(512));
write(path.join(OUT, 'trayTemplate.png'), drawTrayIcon(22));
write(path.join(OUT, 'trayTemplate@2x.png'), drawTrayIcon(44));

console.log(`icons written to ${OUT}`);
