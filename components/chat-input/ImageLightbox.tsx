"use client";

/**
 * 图片查看器（贴图 / 拖图的「点开看大图」）。
 *
 * 需求边界：点开必须能看到原图，并且能做正常图片操作 —— 缩放（滚轮/按钮/双击）、
 * 拖拽平移、旋转、上一张/下一张、下载、复制到剪贴板、在新标签打开、Esc 关闭。
 *
 * 性能约束（第二部分·保速度）：
 *   - 用 `createPortal` 挂到 body，不用 `<dialog>`，不进输入框的布局树；
 *   - 缩放/平移**不触发 React 重渲染**：直接写 `transform`，拖动一帧一次 rAF；
 *   - 只在打开时挂载，关掉即卸载（含 body 滚动锁的还原）；
 *   - 不引第三方看图库（体积 + 首帧都亏）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { AttachedImage } from "./types";
import { estimateImageTokens, imageExtensionForMime } from "@/lib/image-attachment";
import { useI18n } from "@/components/I18nProvider";

export interface ImageLightboxProps {
  images: readonly AttachedImage[];
  index: number;
  onIndexChange?: (index: number) => void;
  onClose: () => void;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;

/** 附件的可显示地址：优先原图 data URL，退回缩略图 object URL。 */
export function attachmentSrc(image: AttachedImage): string {
  if (image.mimeType && image.data) return `data:${image.mimeType};base64,${image.data}`;
  return image.previewUrl;
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImageLightbox({ images, index, onIndexChange, onClose }: ImageLightboxProps) {
  const { t } = useI18n();
  const image = images[index];
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const rotationRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [scaleLabel, setScaleLabel] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applyTransform = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const node = imgRef.current;
      if (!node) return;
      const { x, y } = offsetRef.current;
      node.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scaleRef.current}) rotate(${rotationRef.current}deg)`;
      setScaleLabel(scaleRef.current);
    });
  }, []);

  const resetView = useCallback(() => {
    scaleRef.current = 1;
    offsetRef.current = { x: 0, y: 0 };
    rotationRef.current = 0;
    setRotation(0);
    applyTransform();
  }, [applyTransform]);

  const zoomBy = useCallback(
    (factor: number) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scaleRef.current * factor));
      if (next === scaleRef.current) return;
      // 以视图中心为锚点缩放，视觉上不会「跑掉」。
      const stage = stageRef.current;
      const ratio = next / scaleRef.current;
      if (stage) {
        const cx = stage.clientWidth / 2;
        const cy = stage.clientHeight / 2;
        offsetRef.current = {
          x: cx - (cx - offsetRef.current.x) * ratio,
          y: cy - (cy - offsetRef.current.y) * ratio,
        };
      }
      scaleRef.current = next;
      applyTransform();
    },
    [applyTransform],
  );

  const rotate = useCallback(() => {
    rotationRef.current = (rotationRef.current + 90) % 360;
    setRotation(rotationRef.current);
    applyTransform();
  }, [applyTransform]);

  const go = useCallback(
    (delta: number) => {
      if (images.length < 2 || !onIndexChange) return;
      const next = (index + delta + images.length) % images.length;
      resetView();
      setDimensions(null);
      onIndexChange(next);
    },
    [images.length, index, onIndexChange, resetView],
  );

  const fileName = image
    ? `pasted-image-${index + 1}.${imageExtensionForMime(image.mimeType)}`
    : "image.png";

  const download = useCallback(() => {
    if (!image) return;
    const anchor = document.createElement("a");
    anchor.href = attachmentSrc(image);
    anchor.download = fileName;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [image, fileName]);

  const copy = useCallback(async () => {
    if (!image) return;
    try {
      const response = await fetch(attachmentSrc(image));
      const blob = await response.blob();
      const type = blob.type || image.mimeType || "image/png";
      await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      setNotice(t("lightbox.copied"));
    } catch {
      setNotice(t("lightbox.copyFailed"));
    }
  }, [image, t]);

  const openInTab = useCallback(() => {
    if (!image) return;
    window.open(attachmentSrc(image), "_blank", "noopener,noreferrer");
  }, [image]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 1_600);
    return () => clearTimeout(timer);
  }, [notice]);

  // 关闭时还原一切副作用（滚动锁 / rAF）。
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          onClose();
          break;
        case "ArrowLeft":
          event.preventDefault();
          go(-1);
          break;
        case "ArrowRight":
          event.preventDefault();
          go(1);
          break;
        case "+":
        case "=":
          event.preventDefault();
          zoomBy(ZOOM_STEP);
          break;
        case "-":
        case "_":
          event.preventDefault();
          zoomBy(1 / ZOOM_STEP);
          break;
        case "0":
          event.preventDefault();
          resetView();
          break;
        case "r":
        case "R":
          event.preventDefault();
          rotate();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [go, onClose, resetView, rotate, zoomBy]);

  if (!image || typeof document === "undefined") return null;

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const stage = stageRef.current;
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scaleRef.current * factor));
    const ratio = next / scaleRef.current;
    if (stage && ratio !== 1) {
      // 以光标为锚点：放大时光标下的像素不动。
      const rect = stage.getBoundingClientRect();
      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      offsetRef.current = {
        x: cx - (cx - offsetRef.current.x) * ratio,
        y: cy - (cy - offsetRef.current.y) * ratio,
      };
    }
    scaleRef.current = next;
    applyTransform();
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      ox: offsetRef.current.x,
      oy: offsetRef.current.y,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    offsetRef.current = {
      x: drag.ox + (event.clientX - drag.x),
      y: drag.oy + (event.clientY - drag.y),
    };
    applyTransform();
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const toggleZoom = () => {
    if (scaleRef.current > 1.01) resetView();
    else {
      scaleRef.current = 2;
      applyTransform();
    }
  };

  const width = dimensions?.width || image.width || 0;
  const height = dimensions?.height || image.height || 0;
  const tokens = estimateImageTokens(width, height);
  const byteLabel = formatBytes(image.bytes);
  const originalLabel = formatBytes(image.originalBytes);
  const toolbarButton =
    "flex h-8 w-8 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("lightbox.title")}
      className="fixed inset-0 z-[1300] flex flex-col bg-black/85 backdrop-blur-[2px]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* 顶部工具条：文件名 / 尺寸 / token 估算 / 操作 */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-[12px] text-white/70">
        <span className="truncate font-medium text-white/85">{fileName}</span>
        {width > 0 && height > 0 && (
          <span className="shrink-0 tabular-nums">
            {width}×{height}
            {tokens > 0 ? ` · ≈${tokens.toLocaleString()} tokens` : ""}
          </span>
        )}
        {byteLabel && (
          <span className="shrink-0 tabular-nums">
            {byteLabel}
            {originalLabel && image.bytes && image.originalBytes && image.bytes < image.originalBytes
              ? ` (${originalLabel} → ${byteLabel})`
              : ""}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className={toolbarButton} title={t("lightbox.zoomOut")} aria-label={t("lightbox.zoomOut")} onClick={() => zoomBy(1 / ZOOM_STEP)}>
            <ZoomOut size={16} strokeWidth={2} />
          </button>
          <span className="w-11 shrink-0 text-center tabular-nums text-white/70">
            {Math.round(scaleLabel * 100)}%
          </span>
          <button type="button" className={toolbarButton} title={t("lightbox.zoomIn")} aria-label={t("lightbox.zoomIn")} onClick={() => zoomBy(ZOOM_STEP)}>
            <ZoomIn size={16} strokeWidth={2} />
          </button>
          <button type="button" className={toolbarButton} title={t("lightbox.rotate")} aria-label={t("lightbox.rotate")} onClick={rotate}>
            <RotateCw size={16} strokeWidth={2} />
          </button>
          <button type="button" className={toolbarButton} title={t("lightbox.download")} aria-label={t("lightbox.download")} onClick={download}>
            <Download size={16} strokeWidth={2} />
          </button>
          <button type="button" className={toolbarButton} title={t("lightbox.copy")} aria-label={t("lightbox.copy")} onClick={() => void copy()}>
            <Copy size={16} strokeWidth={2} />
          </button>
          <button type="button" className={toolbarButton} title={t("lightbox.openInTab")} aria-label={t("lightbox.openInTab")} onClick={openInTab}>
            <ExternalLink size={16} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="ml-1 flex h-8 w-8 items-center justify-center rounded-md bg-white/10 text-white transition-colors hover:bg-white/20"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <X size={16} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      {/* 画布：拖动平移 / 滚轮缩放 / 双击 1x↔2x */}
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        style={{ cursor: dragRef.current ? "grabbing" : "grab", touchAction: "none" }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={toggleZoom}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={attachmentSrc(image)}
          alt={fileName}
          draggable={false}
          decoding="async"
          className="max-h-full max-w-full select-none shadow-[0_10px_40px_rgba(0,0,0,0.5)]"
          style={{
            transform: `rotate(${rotation}deg)`,
            transformOrigin: "center center",
            willChange: "transform",
            imageRendering: scaleRef.current >= 3 ? "pixelated" : "auto",
          }}
          onLoad={(event) => {
            const node = event.currentTarget;
            if (node.naturalWidth > 0) {
              setDimensions({ width: node.naturalWidth, height: node.naturalHeight });
            }
          }}
        />
        {images.length > 1 && (
          <>
            <button
              type="button"
              aria-label={t("lightbox.prev")}
              className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/85 transition-colors hover:bg-black/60"
              onClick={() => go(-1)}
            >
              <ChevronLeft size={20} strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label={t("lightbox.next")}
              className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/85 transition-colors hover:bg-black/60"
              onClick={() => go(1)}
            >
              <ChevronRight size={20} strokeWidth={2} />
            </button>
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-2.5 py-0.5 text-[11px] text-white/80">
              {index + 1} / {images.length}
            </div>
          </>
        )}
      </div>

      {notice && (
        <div className="pointer-events-none absolute bottom-14 left-1/2 -translate-x-1/2 rounded-md bg-white px-3 py-1 text-[12px] text-ink shadow-lg">
          {notice}
        </div>
      )}
    </div>,
    document.body,
  );
}
