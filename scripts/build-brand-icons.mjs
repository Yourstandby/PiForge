// Generates PiForge's brand icons from one SVG source.
//
//   node scripts/build-brand-icons.mjs
//
// Outputs: build/icon.ico, build/icon.icns, build/icon.png,
// build/tray-icon.ico, app/favicon.ico
//
// ICO/ICNS are assembled directly from PNG frames (Vista+ ICO supports PNG
// entries; ICNS uses the modern `ic07`-`ic14` PNG chunk types), so no native
// image tooling beyond sharp is required.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0c1c31"/>
      <stop offset="1" stop-color="#050a12"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.08" r="0.78">
      <stop offset="0" stop-color="#58a6ff" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#58a6ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="beam" x1="244" y1="344" x2="780" y2="344" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#8fd6ff"/>
      <stop offset="0.52" stop-color="#d6f2ff"/>
      <stop offset="1" stop-color="#5ba8ff"/>
    </linearGradient>
    <linearGradient id="leg" x1="0" y1="352" x2="0" y2="798" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7cc9ff"/>
      <stop offset="1" stop-color="#3f7fe0" stop-opacity="0.78"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="224" fill="url(#bg)"/>
  <rect width="1024" height="1024" rx="224" fill="url(#glow)"/>
  <rect x="244" y="306" width="536" height="76" rx="38" fill="url(#beam)"/>
  <rect x="330" y="352" width="76" height="446" rx="34" transform="rotate(-3 368 575)" fill="url(#leg)"/>
  <rect x="618" y="352" width="76" height="446" rx="34" transform="rotate(3 656 575)" fill="url(#leg)"/>
  <rect x="292" y="836" width="440" height="10" rx="5" fill="#7cc9ff" opacity="0.18"/>
  <path d="M812 232 l15 42 42 15 -42 15 -15 42 -15 -42 -42 -15 42 -15 z" fill="#d9f2ff" opacity="0.9"/>
</svg>`;

const svgBuffer = Buffer.from(svg);

async function png(size) {
  return sharp(svgBuffer, { density: 384 })
    .resize(size, size, { fit: "contain" })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  const entries = [];
  let offset = 6 + frames.length * 16;
  for (const { size, data } of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...frames.map((frame) => frame.data)]);
}

function buildIcns(chunks) {
  const parts = chunks.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoFrames = [];
for (const size of icoSizes) {
  icoFrames.push({ size, data: await png(size) });
}
const ico = buildIco(icoFrames);

const icnsMap = [
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 512],
  ["ic14", 1024],
];
const icnsChunks = [];
for (const [type, size] of icnsMap) {
  icnsChunks.push({ type, data: await png(size) });
}
const icns = buildIcns(icnsChunks);

mkdirSync(join(root, "build"), { recursive: true });
mkdirSync(join(root, "public"), { recursive: true });
writeFileSync(join(root, "build", "icon.ico"), ico);
writeFileSync(join(root, "build", "tray-icon.ico"), ico);
writeFileSync(join(root, "app", "favicon.ico"), ico);
writeFileSync(join(root, "build", "icon.icns"), icns);
writeFileSync(join(root, "build", "icon.png"), await png(512));

console.log(`icon.ico ${ico.length} bytes, icon.icns ${icns.length} bytes`);
