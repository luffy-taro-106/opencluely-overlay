'use strict';
// Procedural app icon: no remote assets or build-time graphics dependency.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, crc]);
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = (x + 0.5) / size, b = (y + 0.5) / size;
    const dx = Math.abs(a - 0.5), dy = Math.abs(b - 0.5);
    const radius = Math.hypot(Math.max(0, dx - 0.29), Math.max(0, dy - 0.29));
    const inside = radius < 0.16;
    const star = Math.abs(a - 0.5) / 0.255 + Math.abs(b - 0.5) / 0.30 < 1;
    const hole = Math.abs(a - 0.5) < 0.028 && Math.abs(b - 0.5) < 0.028;
    const index = y * (size * 4 + 1) + 1 + x * 4;
    raw.set(star && !hole ? [24, 40, 35, inside ? 255 : 0] : [174, 232, 192, inside ? 255 : 0], index);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const directory = path.join(__dirname, '..', 'overlay', 'assets');
fs.mkdirSync(directory, { recursive: true });
const icon = png(256), tray = png(32);
fs.writeFileSync(path.join(directory, 'icon.png'), icon);
fs.writeFileSync(path.join(directory, 'tray.png'), tray);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(icon.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(directory, 'icon.ico'), Buffer.concat([ico, icon]));
