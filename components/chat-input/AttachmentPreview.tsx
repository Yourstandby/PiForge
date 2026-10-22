"use client";

/**
 * 输入框里的贴图缩略条。
 *
 * 关键交互：**点缩略图 = 打开大图查看器**（以前是纯 `<img>`，点不动，只能删掉）。
 * 删图按钮独立成一个命中区，不会顺手打开查看器；键盘 Enter / Space 同样能开。
 * 缩略图同时显示长边像素与 token 估算，贴图前就知道这张图大概要吃多少上下文。
 */
import React, { useCallback, useState } from "react";
import { X } from "lucide-react";
import type { AttachedImage } from "./types";
import { ImageLightbox } from "./ImageLightbox";
import { estimateImageTokens } from "@/lib/image-attachment";
import { useI18n } from "@/components/I18nProvider";

interface AttachmentPreviewProps {
  attachedImages: AttachedImage[];
  onRemoveImage: (index: number) => void;
}

const THUMB_SIZE = 56;

export function AttachmentPreview({ attachedImages, onRemoveImage }: AttachmentPreviewProps) {
  const { t } = useI18n();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const close = useCallback(() => setOpenIndex(null), []);

  if (attachedImages.length === 0) return null;

  // 合计口径：图片 token 每轮都会随历史重发，贴之前就该看见总量。
  const totalTokens = attachedImages.reduce(
    (sum, image) => sum + estimateImageTokens(image.width ?? 0, image.height ?? 0),
    0,
  );

  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
      {attachedImages.map((img, i) => {
        const tokens = estimateImageTokens(img.width ?? 0, img.height ?? 0);
        return (
          <div key={i} style={{ position: "relative", flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setOpenIndex(i)}
              title={`${t("lightbox.open")}${tokens > 0 ? ` · ≈${tokens.toLocaleString()} tokens` : ""}`}
              aria-label={t("lightbox.open")}
              style={{
                display: "block",
                padding: 0,
                border: "1px solid var(--border)",
                borderRadius: 6,
                overflow: "hidden",
                cursor: "zoom-in",
                background: "var(--bg-panel)",
                lineHeight: 0,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.previewUrl}
                alt=""
                width={THUMB_SIZE}
                height={THUMB_SIZE}
                loading="lazy"
                decoding="async"
                draggable={false}
                style={{ width: THUMB_SIZE, height: THUMB_SIZE, objectFit: "cover", display: "block" }}
              />
            </button>
            {tokens > 0 && (
              <span
                title={t("lightbox.hint")}
                style={{
                  position: "absolute",
                  left: 2,
                  bottom: 2,
                  padding: "0 3px",
                  borderRadius: 4,
                  background: "rgba(0,0,0,0.55)",
                  color: "#fff",
                  fontSize: 9,
                  lineHeight: "13px",
                  pointerEvents: "none",
                }}
              >
                ≈{tokens >= 1000 ? `${Math.round(tokens / 100) / 10}k` : tokens}
              </span>
            )}
            <button
              type="button"
              onClick={() => onRemoveImage(i)}
              aria-label={t("common.close")}
              style={{
                position: "absolute", top: -4, right: -4,
                width: 16, height: 16, borderRadius: "50%",
                background: "var(--bg-panel)", border: "1px solid var(--border)",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", padding: 0, color: "var(--text-muted)",
              }}
            >
              <X size={9} strokeWidth={2} />
            </button>
          </div>
        );
      })}
      {attachedImages.length > 1 && totalTokens > 0 && (
        <span
          title={t("lightbox.hint")}
          style={{ alignSelf: "center", fontSize: 11, color: "var(--text-muted)" }}
        >
          {attachedImages.length} 张 · ≈{totalTokens.toLocaleString()} tokens/轮
        </span>
      )}
      {openIndex !== null && openIndex < attachedImages.length && (
        <ImageLightbox
          images={attachedImages}
          index={openIndex}
          onIndexChange={setOpenIndex}
          onClose={close}
        />
      )}
    </div>
  );
}
