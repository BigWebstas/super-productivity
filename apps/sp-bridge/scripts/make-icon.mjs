/**
 * Generates the agent's icon: `build/icon.ico` (installer) and
 * `build/icon.png` (tray + Linux).
 *
 * Written by hand rather than committed as a binary blob so the icon is
 * reviewable, reproducible, and adjustable without a design tool. Everything
 * here is deterministic: same bytes on every run.
 *
 * Formats:
 *  - PNG  — signature, IHDR, IDAT (zlib of filtered scanlines), IEND, each
 *           chunk length/type/data/CRC.
 *  - ICO  — 6-byte header, one 16-byte directory entry, then the PNG bytes.
 *           Embedding a PNG inside an .ico is valid for sizes >= 256 and is
 *           what Windows expects for large icons.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = resolve(appDir, 'build');

const SIZE = 256;

// ── CRC32 (PNG chunk checksums) ──────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
};

// ── PNG ──────────────────────────────────────────────────────────────────────
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
};

const encodePng = (width, height, rgba) => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with filter type 0 (None). Filter 0 keeps the
  // encoder trivial and the file small enough at this size.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

// ── the icon itself ──────────────────────────────────────────────────────────
/**
 * A rounded dark-teal square with a lighter check mark.
 *
 * Anti-aliasing is done by supersampling 3x3 per pixel and averaging coverage,
 * which is why the edges look clean at 16px in the tray without any external
 * rasteriser.
 */
const SS = 3; // supersampling factor per axis

const INK = [244, 247, 246];
const BG = [26, 54, 54];
const ACCENT = [126, 200, 166];

const roundedSquareCoverage = (x, y) => {
  // 22% corner radius, in supersampled units.
  const r = SIZE * 0.22;
  const inset = SIZE * 0.06;
  const min = inset;
  const max = SIZE - inset;
  if (x < min || y < min || x > max || y > max) {
    return 0;
  }
  const cx = Math.min(Math.max(x, min + r), max - r);
  const cy = Math.min(Math.max(y, min + r), max - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r ? 1 : 0;
};

/** Distance from point p to segment ab, for the check-mark strokes. */
const distToSegment = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lenSq = vx * vx + vy * vy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
};

// Check mark: short down-left stroke, then a long up-right stroke.
const CHECK_A = [SIZE * 0.29, SIZE * 0.52];
const CHECK_B = [SIZE * 0.44, SIZE * 0.67];
const CHECK_C = [SIZE * 0.72, SIZE * 0.35];
const STROKE = SIZE * 0.075;

const renderIcon = () => {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let bgHits = 0;
      let inkHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (roundedSquareCoverage(px, py) === 1) {
            bgHits++;
            const onCheck =
              distToSegment(px, py, ...CHECK_A, ...CHECK_B) <= STROKE ||
              distToSegment(px, py, ...CHECK_B, ...CHECK_C) <= STROKE;
            if (onCheck) {
              inkHits++;
            }
          }
        }
      }
      const total = SS * SS;
      const alpha = bgHits / total;
      const ink = inkHits / total;
      const offset = (y * SIZE + x) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[offset + c] = Math.round(
          BG[c] * (1 - ink) + (ink > 0 ? INK[c] : ACCENT[c]) * ink,
        );
      }
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
};

// ── ICO container ────────────────────────────────────────────────────────────
const buildIco = (pngBuffer) => {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = SIZE === 256 ? 0 : SIZE; // width (0 means 256)
  entry[1] = SIZE === 256 ? 0 : SIZE; // height
  entry[2] = 0; // palette size (0 for truecolour)
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32BE(0, 8);
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, pngBuffer]);
};

mkdirSync(buildDir, { recursive: true });
const rgba = renderIcon();
const png = encodePng(SIZE, SIZE, rgba);
writeFileSync(resolve(buildDir, 'icon.png'), png);
writeFileSync(resolve(buildDir, 'icon.ico'), buildIco(png));
console.log(
  `[icon] build/icon.png (${SIZE}x${SIZE}, ${png.length} bytes)\n` +
    `[icon] build/icon.ico (${SIZE}x${SIZE})`,
);
