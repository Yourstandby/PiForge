/**
 * 图片处理的后台线程（OffscreenCanvas Worker）。
 *
 * 为什么不在主线程做：一张 4K 截图要走「解码 → 缩放到 1568px → JPEG 编码 →
 * base64」四步，合计 200~400ms CPU。这些活以前全在渲染进程主线程上，贴图那一
 * 瞬间输入框、消息流、滚动都会跟着顿一下。
 *
 * 现在：
 *   - `createImageBitmap` / `OffscreenCanvas` / `convertToBlob` / base64 全部在
 *     worker 里跑，主线程只负责 `URL.createObjectURL` 与 setState；
 *   - 传给模型的那份依旧按像素预算压缩（省 token），但 `originalUrl` 由主线程
 *     指向原始文件 —— 查看器看到的永远是原图；
 *   - worker 源码内联成 Blob URL（避开 Next 静态导出 / Turbopack 的 worker 打包
 *     差异），CSP 需要 `worker-src 'self' blob:`（见 lib/csp.ts）。
 *
 * 任何一步不可用（CSP 拦截、无 OffscreenCanvas、worker 崩溃、超时）都返回
 * `null`，调用方回退到主线程实现 —— 宁可慢一点，也不能让图贴不进去。
 */

export interface ImageWorkerOptions {
  /** 视觉模型的长边上限。 */
  maxEdge: number;
  /** 像素总预算。 */
  maxPixels: number;
  /** 像素已达标时，不超过这个字节数就原样发送。 */
  passthroughBytes: number;
  /** 缩略图长边。 */
  thumbEdge: number;
  /** 缩略图 JPEG 质量。 */
  thumbQuality: number;
  /** 整图 JPEG 质量。 */
  jpegQuality: number;
}

export interface WorkerProcessedImage {
  /** base64，无前缀。 */
  data: string;
  mimeType: string;
  /** 发给模型的像素尺寸；原样发送时为原始尺寸。 */
  width: number;
  height: number;
  bytes: number;
  originalBytes: number;
  /** 缩略图（≤thumbEdge）。worker 里生成，主线程只 createObjectURL。 */
  thumbnail: Blob | null;
}

const INIT_TIMEOUT_MS = 5_000;
const JOB_TIMEOUT_MS = 30_000;

/**
 * worker 源码。写成字符串而不是独立模块：静态导出（`piforge://`）下
 * `new Worker(new URL(...))` 产出的 chunk 要额外过协议 MIME 与 CSP 两道关，
 * 而这段代码不需要任何 import，内联成 Blob 最稳。
 */
export function buildWorkerSource(options: ImageWorkerOptions): string {
  const opts = JSON.stringify(options);
  return `"use strict";
const OPTS = ${opts};
const MAX_EDGE = OPTS.maxEdge;
const MAX_PIXELS = OPTS.maxPixels;
const PASSTHROUGH = OPTS.passthroughBytes;
const THUMB_EDGE = OPTS.thumbEdge;
const THUMB_QUALITY = OPTS.thumbQuality;
const JPEG_QUALITY = OPTS.jpegQuality;
const NO_REENCODE = /^image\\/(gif|svg\\+xml)$/i;

function fitWithin(w, h, maxEdge, maxPixels) {
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 };
  let scale = Math.min(1, maxEdge / Math.max(w, h));
  if (w * h * scale * scale > maxPixels) scale = Math.min(scale, Math.sqrt(maxPixels / (w * h)));
  if (!(scale > 0)) return { width: 0, height: 0 };
  // floor：round 会把像素推过预算（4000×3000 → 1150102 > 1150000）。
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}

function blobToBase64(blob) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () {
      const text = String(reader.result);
      const comma = text.indexOf(",");
      resolve(comma >= 0 ? text.slice(comma + 1) : text);
    };
    reader.onerror = function () { reject(reader.error || new Error("read failed")); };
    reader.readAsDataURL(blob);
  });
}

function hasTransparency(bitmap) {
  try {
    const probe = 24;
    const canvas = new OffscreenCanvas(probe, probe);
    const context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
    if (!context) return false;
    context.clearRect(0, 0, probe, probe);
    context.drawImage(bitmap, 0, 0, probe, probe);
    const data = context.getImageData(0, 0, probe, probe).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function makeThumb(bitmap, w, h, alpha) {
  const fit = fitWithin(w, h, THUMB_EDGE, THUMB_EDGE * THUMB_EDGE);
  if (!fit.width || !fit.height) return null;
  try {
    const canvas = new OffscreenCanvas(fit.width, fit.height);
    const context = canvas.getContext("2d", { alpha: alpha });
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "medium";
    if (!alpha) {
      context.fillStyle = "#FFFFFF";
      context.fillRect(0, 0, fit.width, fit.height);
    }
    context.drawImage(bitmap, 0, 0, fit.width, fit.height);
    return await canvas.convertToBlob({ type: alpha ? "image/png" : "image/jpeg", quality: THUMB_QUALITY });
  } catch (error) {
    return null;
  }
}

async function processImage(file) {
  const originalBytes = file.size;
  const type = file.type || "";

  // GIF / SVG 重编码会丢东西（动画、矢量），原样发送。
  if (NO_REENCODE.test(type)) {
    return {
      data: await blobToBase64(file),
      mimeType: type || "image/png",
      width: 0,
      height: 0,
      bytes: originalBytes,
      originalBytes: originalBytes,
      thumbnail: null,
    };
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (error) {
    return null; // 解不开：交给主线程那条老路径再试
  }

  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const target = fitWithin(width, height, MAX_EDGE, MAX_PIXELS);
    const sameSize = target.width === width && target.height === height;

    // 像素已达标且体积不大：原样发送，保住无损清晰度，也省一次重编码。
    if (sameSize && originalBytes <= PASSTHROUGH) {
      const pair = await Promise.all([blobToBase64(file), makeThumb(bitmap, width, height, false)]);
      return {
        data: pair[0],
        mimeType: type || "image/png",
        width: width,
        height: height,
        bytes: originalBytes,
        originalBytes: originalBytes,
        thumbnail: pair[1],
      };
    }

    if (!target.width || !target.height) return null;

    const alpha = hasTransparency(bitmap);
    const mimeType = alpha ? "image/png" : "image/jpeg";
    const canvas = new OffscreenCanvas(target.width, target.height);
    const context = canvas.getContext("2d", { alpha: alpha });
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    if (!alpha) {
      context.fillStyle = "#FFFFFF";
      context.fillRect(0, 0, target.width, target.height);
    }
    context.drawImage(bitmap, 0, 0, target.width, target.height);

    const pair = await Promise.all([
      canvas.convertToBlob({ type: mimeType, quality: JPEG_QUALITY }),
      makeThumb(bitmap, width, height, alpha),
    ]);
    const blob = pair[0];
    if (!blob || blob.size === 0) return null;
    return {
      data: await blobToBase64(blob),
      mimeType: mimeType,
      width: target.width,
      height: target.height,
      bytes: blob.size,
      originalBytes: originalBytes,
      thumbnail: pair[1],
    };
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
}

self.onmessage = async function (event) {
  const message = event.data;
  if (!message || typeof message.id !== "number") return;
  if (message.type === "ping") {
    self.postMessage({ id: message.id, ok: true, pong: true });
    return;
  }
  try {
    const result = await processImage(message.file);
    if (!result) {
      self.postMessage({ id: message.id, ok: false, unsupported: true });
      return;
    }
    self.postMessage({ id: message.id, ok: true, result: result });
  } catch (error) {
    self.postMessage({
      id: message.id,
      ok: false,
      error: String((error && error.message) || error),
    });
  }
};
`;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  pong?: boolean;
  unsupported?: boolean;
  error?: string;
  result?: WorkerProcessedImage;
}

interface PendingJob {
  resolve: (reply: WorkerReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerSlot {
  worker: Worker;
  url: string;
  ready: Promise<void>;
}

let slot: WorkerSlot | null = null;
let slotOptions: string | null = null;
let unavailable = false;
let seq = 0;
const pending = new Map<number, PendingJob>();

function teardown(): void {
  const current = slot;
  slot = null;
  slotOptions = null;
  if (!current) return;
  try {
    current.worker.terminate();
  } catch {
    /* ignore */
  }
  URL.revokeObjectURL(current.url);
  for (const [id, job] of pending) {
    clearTimeout(job.timer);
    pending.delete(id);
    job.reject(new Error("image worker stopped"));
  }
}

function send(worker: Worker, message: Record<string, unknown>, timeoutMs: number): Promise<WorkerReply> {
  return new Promise<WorkerReply>((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      // 卡死就整条线程换掉：下一张图会重建 worker，而不是跟着一起堵。
      teardown();
      reject(new Error("image worker timeout"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      worker.postMessage({ ...message, id });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function acquireSlot(options: ImageWorkerOptions): WorkerSlot | null {
  const key = JSON.stringify(options);
  if (slot && slotOptions === key) return slot;
  if (slot && slotOptions !== key) teardown();
  if (unavailable) return null;
  if (
    typeof Worker === "undefined" ||
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap !== "function"
  ) {
    unavailable = true;
    return null;
  }

  let url = "";
  try {
    url = URL.createObjectURL(new Blob([buildWorkerSource(options)], { type: "text/javascript" }));
    const worker = new Worker(url);
    const fail = () => {
      unavailable = true;
      teardown();
    };
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (!reply || typeof reply.id !== "number") return;
      const job = pending.get(reply.id);
      if (!job) return;
      pending.delete(reply.id);
      clearTimeout(job.timer);
      job.resolve(reply);
    };
    worker.onerror = fail;
    // 先挂 onmessage 再 ping：否则首帧回包可能撞在监听器就位之前。
    const ready = send(worker, { type: "ping" }, INIT_TIMEOUT_MS).then((reply) => {
      if (!reply.pong) throw new Error("image worker did not answer ping");
    });
    ready.catch(fail);

    slot = { worker, url, ready };
    slotOptions = key;
    return slot;
  } catch {
    if (url) URL.revokeObjectURL(url);
    unavailable = true;
    return null;
  }
}

/**
 * 在 worker 里处理一张图；任何不适用都返回 `null`（调用方回退主线程实现）。
 */
export async function processImageOffThread(
  file: File,
  options: ImageWorkerOptions,
): Promise<WorkerProcessedImage | null> {
  const current = acquireSlot(options);
  if (!current) return null;
  try {
    await current.ready;
  } catch {
    return null;
  }
  if (slot !== current) return null;
  try {
    const reply = await send(current.worker, { type: "process", file }, JOB_TIMEOUT_MS);
    if (!reply.ok || !reply.result) return null;
    const result = reply.result;
    if (!result.data || !result.mimeType) return null;
    return result;
  } catch {
    return null;
  }
}

/** 供单测 / 诊断使用：worker 是否已被判定不可用。 */
export function isImageWorkerUnavailable(): boolean {
  return unavailable;
}
