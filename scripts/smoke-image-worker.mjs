/**
 * 图片 Worker 冒烟（Electron 真机跑一遍，不靠单测猜）。
 *
 * 单测只能编译 worker 源码字符串；真正会炸的地方是浏览器 API 侧：
 *   - `new Worker(blobURL)` 是否被 CSP / origin 拦；
 *   - `OffscreenCanvas.convertToBlob` 的参数、`FileReader` 在 worker 里是否可用；
 *   - 4K 截图是否真的被压到 1568px，且透传路径不重编码。
 *
 * 用法（worker 源码由 node 侧生成后指过来，见 package.json 的 smoke:image-worker）：
 *   IMAGE_WORKER_SOURCE_FILE=<path> electron scripts/smoke-image-worker.mjs
 */
import { app, BrowserWindow } from "electron";
import { readFileSync } from "node:fs";

const SOURCE_FILE = process.env.IMAGE_WORKER_SOURCE_FILE;

function fail(message) {
  console.error(`[image-worker-smoke] FAIL: ${message}`);
  app.exit(1);
}

async function main() {
  if (!SOURCE_FILE) {
    fail("IMAGE_WORKER_SOURCE_FILE is not set");
    return;
  }
  const workerSource = readFileSync(SOURCE_FILE, "utf8");

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  await win.loadURL("data:text/html,<!doctype html><meta charset=utf-8><title>smoke</title>");
  await win.webContents.executeJavaScript(
    `window.__workerSource = ${JSON.stringify(workerSource)}; true;`,
  );

  const result = await win.webContents.executeJavaScript(`(async () => {
    const makeFile = async (w, h) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, w, h);
      context.fillStyle = "#1d4ed8";
      context.fillRect(0, 0, Math.max(1, w >> 1), Math.max(1, h >> 1));
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      return new File([blob], "screenshot.png", { type: "image/png" });
    };

    const run = (file) => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([window.__workerSource], { type: "text/javascript" }));
      const worker = new Worker(url);
      const done = (value) => { worker.terminate(); URL.revokeObjectURL(url); resolve(value); };
      worker.onmessage = (event) => done(event.data);
      worker.onerror = (event) => {
        worker.terminate();
        URL.revokeObjectURL(url);
        reject(new Error("worker error: " + (event.message || "unknown")));
      };
      worker.postMessage({ id: 1, type: "process", file });
    });

    const big = await run(await makeFile(4000, 3000));
    const small = await run(await makeFile(800, 600));
    return {
      big: big.ok ? {
        width: big.result.width,
        height: big.result.height,
        bytes: big.result.bytes,
        mimeType: big.result.mimeType,
        dataLength: big.result.data.length,
        thumb: big.result.thumbnail ? { type: big.result.thumbnail.type, size: big.result.thumbnail.size } : null,
      } : { error: big.error || "unsupported" },
      small: small.ok ? {
        width: small.result.width,
        height: small.result.height,
        bytes: small.result.bytes,
        mimeType: small.result.mimeType,
        dataLength: small.result.data.length,
        thumb: small.result.thumbnail ? { type: small.result.thumbnail.type, size: small.result.thumbnail.size } : null,
      } : { error: small.error || "unsupported" },
    };
  })()`);

  const problems = [];
  if (result.big.error) problems.push(`4K job failed: ${result.big.error}`);
  else {
    if (Math.max(result.big.width, result.big.height) > 1568) problems.push(`4K not downscaled: ${result.big.width}x${result.big.height}`);
    if (result.big.width * result.big.height > 1_150_000) problems.push(`4K over pixel budget: ${result.big.width * result.big.height}`);
    if (!result.big.dataLength) problems.push("4K base64 empty");
    if (!result.big.thumb || !result.big.thumb.size) problems.push("4K thumbnail missing");
  }
  if (result.small.error) problems.push(`small job failed: ${result.small.error}`);
  else {
    if (result.small.width !== 800 || result.small.height !== 600) {
      problems.push(`passthrough resized: ${result.small.width}x${result.small.height}`);
    }
    if (result.small.mimeType !== "image/png") problems.push(`passthrough lost mime: ${result.small.mimeType}`);
  }

  if (problems.length > 0) {
    fail(problems.join("; "));
    return;
  }
  console.log(`[image-worker-smoke] OK ${JSON.stringify(result)}`);
  app.exit(0);
}

app.disableHardwareAcceleration();
app.whenReady().then(main).catch((error) => fail(String(error && error.stack ? error.stack : error)));
