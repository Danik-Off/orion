// Иконка приложения для установщиков — тот же «арк-реактор», что в трее (core/tray.js), только 1024×1024.
// Рисуется кодом, чтобы не держать бинарные файлы в репозитории. Запуск: npm run icon → build/icon.png
// (electron-builder сам делает из неё .ico для Windows и .icns для macOS)
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 1024;
const clamp = (v) => Math.max(0, Math.min(1, v));

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) * (32 / size);
      const ring = clamp(1.6 - Math.abs(d - 12.5));
      const core = clamp(6 - d);
      const glow = clamp((9 - d) / 9) * 0.35;
      const a = Math.max(ring, core, glow);
      const white = clamp(core - 0.3);
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(79 + 176 * white); // R
      rgba[i + 1] = Math.round(209 + 46 * white); // G
      rgba[i + 2] = 255; // B
      rgba[i + 3] = Math.round(255 * a);
    }
  }
  return rgba;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // бит на канал
  header[9] = 6; // RGBA
  // Каждая строка — байт фильтра (0) и пиксели
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png(SIZE, draw(SIZE)));
console.log(`Иконка: ${out}`);
