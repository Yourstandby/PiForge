// Generates PiForge's brand icons from the master artwork.
//
//   node scripts/build-brand-icons.mjs   (npm run icons)
//
// Master: PiForge_ico/PiForge.ico (PNG payload, icon tile + ® mark).
// Outputs: build/icon.ico, build/icon.icns, build/icon.png, build/tray-icon.ico,
//          app/favicon.ico, public/logo.png, public/logo.svg, app/icon.svg
//
// ICO/ICNS are assembled directly from PNG frames (Vista+ ICO supports PNG
// entries; ICNS uses the modern `ic07`-`ic14` PNG chunk types), so no native
// image tooling beyond sharp is required.
//
// The SVG copies embed the raster as a data URI: some managed Windows machines
// run endpoint encryption that mangles `.png` files at rest, so the web UI
// loads the SVG twin while packaging keeps using the PNG/ICO files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const master = readFileSync(join(root, "PiForge_ico", "PiForge.ico"));

// Tight square around the rounded tile (drops the "PiForge" wordmark).
const TILE = { left: 50, top: 15, width: 280, height: 280 };
const source = await sharp(master).extract(TILE).png().toBuffer();

async function png(size) {
  const pipeline = sharp(source).resize(size, size, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
    kernel: "lanczos3",
  });
  // Small frames lose the thin arcs otherwise.
  if (size <= 64) pipeline.sharpen({ sigma: 0.6 });
  return pipeline.png({ compressionLevel: 9 }).toBuffer();
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

function svgFrom(data, size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <image width="${size}" height="${size}" href="data:image/png;base64,${data.toString("base64")}"/>
</svg>
`;
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
writeFileSync(join(root, "public", "logo.png"), await png(256));

const svgPng = await png(256);
writeFileSync(join(root, "public", "logo.svg"), svgFrom(svgPng, 280));
writeFileSync(join(root, "app", "icon.svg"), svgFrom(svgPng, 280));

// The splash screen inlines the mark as a data URI (its CSP is
// `default-src 'none'` with `img-src data:`), so the artwork must be baked
// into electron/startup.html rather than fetched at runtime.
const splashPng = await sharp(source)
  .resize(160, 160, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
    kernel: "lanczos3",
  })
  .png({ compressionLevel: 9, palette: true, colours: 200 })
  .toBuffer();
const startupHtmlPath = join(root, "electron", "startup.html");
if (existsSync(startupHtmlPath)) {
  const html = readFileSync(startupHtmlPath, "utf8");
  const img =
    `<img class="mark-logo" alt="" draggable="false" ` +
    `src="data:image/png;base64,${splashPng.toString("base64")}" />`;
  const next = html.replace(
    /(<!-- splash-logo:start -->)[\s\S]*?(<!-- splash-logo:end -->)/,
    `$1
            ${img}
            $2`,
  );
  if (next !== html) {
    writeFileSync(startupHtmlPath, next);
    console.log(`startup.html splash logo ${splashPng.length} bytes (base64 inlined)`);
  }
}

console.log(
  `icon.ico ${ico.length} bytes · icon.icns ${icns.length} bytes · png/svg variants written`,
);
