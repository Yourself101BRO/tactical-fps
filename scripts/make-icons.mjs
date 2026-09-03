#!/usr/bin/env node
// Generates public/icons/icon-192.png, icon-512.png and apple-touch-icon-180.png
// with a from-scratch PNG encoder (Node's built-in zlib for DEFLATE — no
// image libraries). Draws a dark rounded square with a crosshair glyph
// directly into an RGBA pixel buffer.
//
// Usage: PATH=/opt/homebrew/bin:$PATH node scripts/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ICONS_DIR = path.join(ROOT, 'public', 'icons');

const BG = [0x0b, 0x0d, 0x10]; // matches theme_color in manifest.webmanifest
const FG = [0xf2, 0x5c, 0x2a]; // warm accent, reads clearly on the dark ground

// ---------------------------------------------------------------------------
// Minimal PNG encoder: signature + IHDR + IDAT (zlib) + IEND, 8-bit RGBA.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** rgba: Uint8Array of length width*height*4, row-major, top to bottom. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Each scanline prefixed with filter type 0 (none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idatData = deflateSync(raw, { level: 9 });

  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Drawing: rounded square background + crosshair glyph
// ---------------------------------------------------------------------------

function setPixel(rgba, size, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const o = (y * size + x) * 4;
  // Simple alpha blend over whatever is already there (background is opaque, so this is enough).
  const srcA = a / 255;
  rgba[o] = rgba[o] * (1 - srcA) + r * srcA;
  rgba[o + 1] = rgba[o + 1] * (1 - srcA) + g * srcA;
  rgba[o + 2] = rgba[o + 2] * (1 - srcA) + b * srcA;
  rgba[o + 3] = 255;
}

/** 1 = fully inside, 0 = fully outside, in between near the edge (crude anti-aliasing). */
function roundedSquareCoverage(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - 1 - radius);
  const cy = Math.min(Math.max(y, radius), size - 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= radius - 0.5) return 1;
  if (dist >= radius + 0.5) return 0;
  return radius + 0.5 - dist; // linear falloff across the 1px AA band
}

function lineCoverage(px, py, x0, y0, x1, y1, halfWidth) {
  const vx = x1 - x0, vy = y1 - y0;
  const len2 = vx * vx + vy * vy || 1;
  let t = ((px - x0) * vx + (py - y0) * vy) / len2;
  t = Math.min(1, Math.max(0, t));
  const nx = x0 + t * vx, ny = y0 + t * vy;
  const dist = Math.hypot(px - nx, py - ny);
  if (dist <= halfWidth - 0.5) return 1;
  if (dist >= halfWidth + 0.5) return 0;
  return halfWidth + 0.5 - dist;
}

function ringCoverage(px, py, cx, cy, radius, halfWidth) {
  const dist = Math.abs(Math.hypot(px - cx, py - cy) - radius);
  if (dist <= halfWidth - 0.5) return 1;
  if (dist >= halfWidth + 0.5) return 0;
  return halfWidth + 0.5 - dist;
}

/**
 * Draws the icon at an arbitrary size: dark rounded-rect background (maskable
 * safe-zone padded) plus a crosshair (ring + four ticks + center dot).
 */
function drawIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const cornerRadius = size * 0.22;

  // Background.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cov = roundedSquareCoverage(x, y, size, cornerRadius);
      const o = (y * size + x) * 4;
      rgba[o] = BG[0]; rgba[o + 1] = BG[1]; rgba[o + 2] = BG[2];
      rgba[o + 3] = Math.round(cov * 255);
    }
  }
  // Flatten any AA-transparent edge pixels onto solid BG so the corners don't
  // show as premultiplied fringing on hosts that ignore alpha for app icons.
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    if (rgba[o + 3] < 255) {
      const a = rgba[o + 3] / 255;
      rgba[o] = Math.round(rgba[o] * a);
      rgba[o + 1] = Math.round(rgba[o + 1] * a);
      rgba[o + 2] = Math.round(rgba[o + 2] * a);
      rgba[o + 3] = 255;
    }
  }

  // Crosshair glyph, kept within the ~80% maskable safe zone.
  const cx = size / 2;
  const cy = size / 2;
  const ringR = size * 0.22;
  const strokeW = Math.max(1.4, size * 0.032);
  const tickInner = ringR + size * 0.05;
  const tickOuter = size * 0.42;
  const gapR = ringR * 0.001; // center dot sits inside the ring, ticks stay outside it

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = ringCoverage(x, y, cx, cy, ringR, strokeW * 0.7);
      cov = Math.max(cov, lineCoverage(x, y, cx, cy - tickOuter, cx, cy - tickInner, strokeW * 0.6));
      cov = Math.max(cov, lineCoverage(x, y, cx, cy + tickInner, cx, cy + tickOuter, strokeW * 0.6));
      cov = Math.max(cov, lineCoverage(x, y, cx - tickOuter, cy, cx - tickInner, cy, strokeW * 0.6));
      cov = Math.max(cov, lineCoverage(x, y, cx + tickInner, cy, cx + tickOuter, cy, strokeW * 0.6));
      if (Math.hypot(x - cx, y - cy) <= Math.max(gapR, strokeW * 0.55)) {
        cov = Math.max(cov, 1 - Math.max(0, Math.hypot(x - cx, y - cy) - strokeW * 0.4));
      }
      if (cov > 0) setPixel(rgba, size, x, y, FG[0], FG[1], FG[2], Math.round(cov * 255));
    }
  }

  return rgba;
}

function writeIcon(fileName, size) {
  const rgba = drawIcon(size);
  const png = encodePng(size, size, rgba);
  const dest = path.join(ICONS_DIR, fileName);
  writeFileSync(dest, png);
  console.log(`[icons] wrote ${path.relative(ROOT, dest)} (${size}x${size}, ${(png.length / 1024).toFixed(1)} KB)`);
}

mkdirSync(ICONS_DIR, { recursive: true });
writeIcon('icon-192.png', 192);
writeIcon('icon-512.png', 512);
writeIcon('apple-touch-icon-180.png', 180);
