// Draws the app icon (a microphone) at the sizes the install flow needs. No dependencies.
// Run: node scripts/make-icons.mjs   -> writes public/icons/*.png
import fs from 'node:fs';
import zlib from 'node:zlib';

const BG = [13, 11, 20];
const PINK = [255, 79, 139];
const AMBER = [255, 181, 71];
const INK = [243, 240, 250];

// Shapes are described in a 512-unit square; the artwork stays inside the central 80% so it survives maskable cropping.
const dist = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
};
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function sample(x, y) {
  // Mic head: a capsule with a pink-to-amber gradient
  if (dist(x, y, 256, 170, 256, 230) <= 62) return mix(PINK, AMBER, Math.max(0, Math.min(1, (y - 108) / 184)));
  // Cradle: lower half of a ring around the head
  const r = Math.hypot(x - 256, y - 232);
  if (y >= 232 && Math.abs(r - 104) <= 9) return INK;
  // Stem and base
  if (x >= 247 && x <= 265 && y >= 334 && y <= 392) return INK;
  if (dist(x, y, 206, 398, 306, 398) <= 10) return INK;
  return null;
}

function render(size) {
  const px = Buffer.alloc(size * size * 3);
  const SS = 3; // supersampling for smooth edges
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const x = ((i + (si + 0.5) / SS) / size) * 512;
          const y = ((j + (sj + 0.5) / SS) / size) * 512;
          const c = sample(x, y) ?? BG;
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = (j * size + i) * 3, n = SS * SS;
      px[o] = r / n; px[o + 1] = g / n; px[o + 2] = b / n;
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size) {
  const raw = render(size);
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) raw.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync('public/icons', { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(`public/icons/${name}`, png(size));
  console.log('wrote', name);
}
