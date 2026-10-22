/**
 * 图片附件：贴进输入框的截图怎么变成「模型能看、又不太贵」的数据。
 *
 * 两个目标同时成立，所以这里不是简单 `readAsDataURL`：
 *   1. **看得清**：视觉模型的输入分辨率上限就在 1568px 长边（再大也会被服务端
 *      缩回去）。与其让服务端缩，不如在本地先缩到上限 —— 模型看到的信息完全
 *      一样，网络上传的体积和计费 token 却按 4~10 倍下降。
 *   2. **不卡**：解码/缩放走 `createImageBitmap` + `OffscreenCanvas`（合成线程
 *      上跑），主线程只等一次 Promise；任何一步不可用都退回原始文件读取，
 *      绝不因为优化让图片贴不进去。
 *
 * 纯计算部分（`estimateImageTokens` / `shouldDownscale` / `imageExtensionForMime`）
 * 单独导出，方便单测。
 */

/** 视觉模型的长边上限：超过就被服务端缩，本地先缩省下的是白花的钱。 */
export const MAX_IMAGE_EDGE = 1568;

/**
 * 像素总预算（≈1.15MP）：视觉模型除了长边，还会按**总像素**折算 token。
 * 只卡长边是不够的 —— 2000×1287（2.57MP）虽然每边都不超过 1568 的兄弟规则，
 * 但按 (w×h)/750 算就是 3400 tokens，而按像素预算压到 1.15MP 只要 ≈1500。
 * 同一张图，模型看到的信息量一样，价格差一半以上。
 */
export const MAX_IMAGE_PIXELS = 1_150_000;

/** 小于这个边长、且体积不大的图没必要重编码（重编码本身要时间）。 */
export const SKIP_DOWNSCALE_BYTES = 400 * 1024;

/** 为什么先缩再发是"免费"的：超过这个边长服务端也会缩回去。 */
export const SCHEDULE_HINT =
  `Images longer than ${MAX_IMAGE_EDGE}px are downscaled before they reach the model; ` +
  "the model would have seen the same pixels anyway.";

/** JPEG 重编码质量（视觉模型对 0.9 与 1.0 无差别，体积差一大截）。 */
const JPEG_QUALITY = 0.92;

export interface ProcessedImage {
  /** base64，无前缀。 */
  data: string;
  mimeType: string;
  /** 实际发给模型的像素尺寸（缩放后）。 */
  width: number;
  height: number;
  /** 缩放后的字节数。 */
  bytes: number;
  /** 原始文件字节数（用于 UI 显示省了多少）。 */
  originalBytes: number;
}

export function shouldDownscale(width: number, height: number, bytes: number): boolean {
  return (
    Math.max(width, height) > MAX_IMAGE_EDGE ||
    width * height > MAX_IMAGE_PIXELS ||
    bytes > SKIP_DOWNSCALE_BYTES
  );
}

/**
 * 视觉 token 估算（Anthropic 口径：像素 / 750）。
 * 只用来在 UI 上给个量级提示，不参与任何计费逻辑。
 */
export function estimateImageTokens(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;
  return Math.round((width * height) / 750);
}

export function imageExtensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    case "image/svg+xml":
      return "svg";
    case "image/avif":
      return "avif";
    default:
      return "png";
  }
}

/**
 * 等比缩放到「长边上限 + 像素预算」双重约束内；已经够小就原样返回。
 * 取更严的那个比例，绝不放大。
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge = MAX_IMAGE_EDGE,
  maxPixels = MAX_IMAGE_PIXELS,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  const edgeRatio = Math.min(1, maxEdge / Math.max(width, height));
  const pixelRatio = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  const ratio = Math.min(edgeRatio, pixelRatio);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return readAsDataUrl(blob).then((dataUrl) => {
    const comma = dataUrl.indexOf(",");
    return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), mimeType, JPEG_QUALITY);
    } catch {
      resolve(null);
    }
  });
}

async function decodeSize(file: File): Promise<{ width: number; height: number; draw: CanvasImageSource } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { width: bitmap.width, height: bitmap.height, draw: bitmap };
    } catch {
      /* 退到 <img> 解码 */
    }
  }
  if (typeof document === "undefined") return null;
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "sync";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image decode failed"));
      image.src = url;
    });
    if (!image.naturalWidth) return null;
    return { width: image.naturalWidth, height: image.naturalHeight, draw: image };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function rawAttachment(dataUrl: string, file: File, originalBytes: number): ProcessedImage {
  const comma = dataUrl.indexOf(",");
  const meta = comma >= 0 ? dataUrl.slice(0, comma) : "";
  const mimeType =
    (meta.slice(meta.indexOf(":") + 1, meta.indexOf(";")) || file.type || "image/png") as string;
  return {
    data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
    mimeType,
    width: 0,
    height: 0,
    bytes: originalBytes,
    originalBytes,
  };
}

/**
 * 把用户贴进来 / 拖进来的图片处理成附件。
 *
 * 顺序：解码（bitmap → <img>）→ 按「长边 + 像素预算」缩放 → DOM canvas 重编码
 * （`toBlob` 在 Electron / 浏览器里最稳，`OffscreenCanvas.convertToBlob` 只当备选）
 * → base64。任何一步失败都退回原始字节：宁可贵一点，也不能让图片贴不进去。
 */
export async function processImageFile(file: File): Promise<ProcessedImage> {
  const originalBytes = file.size;
  const decoded = await decodeSize(file).catch(() => null);

  if (decoded) {
    const target = fitWithin(decoded.width, decoded.height);
    const needsWork = shouldDownscale(decoded.width, decoded.height, originalBytes) ||
      target.width !== decoded.width ||
      target.height !== decoded.height;

    if (!needsWork) {
      try {
        return rawAttachment(await readAsDataUrl(file), file, originalBytes);
      } catch {
        /* 落到下面重编码 */
      }
    }

    if (target.width > 0 && target.height > 0) {
      // 截图（无透明需求）走 JPEG，体积能再降一个量级；其余保持 PNG。
      const mimeType = /^image\/(jpeg|jpg|webp)$/i.test(file.type) || /screenshot|snip/i.test(file.name)
        ? "image/jpeg"
        : "image/png";
      const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
      if (canvas) {
        canvas.width = target.width;
        canvas.height = target.height;
        const context = canvas.getContext("2d", { alpha: mimeType === "image/png" });
        if (context) {
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = "high";
          if (mimeType === "image/jpeg") {
            context.fillStyle = "#FFFFFF";
            context.fillRect(0, 0, target.width, target.height);
          }
          context.drawImage(decoded.draw, 0, 0, target.width, target.height);
          const blob = await canvasToBlob(canvas, mimeType);
          if (blob && blob.size > 0) {
            const data = await blobToBase64(blob);
            return {
              data,
              mimeType,
              width: target.width,
              height: target.height,
              bytes: blob.size,
              originalBytes,
            };
          }
        }
      }
    }
    if (decoded.draw instanceof ImageBitmap) decoded.draw.close?.();
  }

  // 兜底：原始字节（HEIC、损坏文件、无 canvas 环境…）
  return rawAttachment(await readAsDataUrl(file), file, originalBytes);
}
