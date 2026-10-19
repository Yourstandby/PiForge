"use client";

import React from "react";
import { X } from "lucide-react";
import type { AttachedImage } from "./types";

interface AttachmentPreviewProps {
  attachedImages: AttachedImage[];
  onRemoveImage: (index: number) => void;
}

export function AttachmentPreview({ attachedImages, onRemoveImage }: AttachmentPreviewProps) {
  if (attachedImages.length === 0) return null;

  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
      {attachedImages.map((img, i) => (
        <div key={i} style={{ position: "relative", flexShrink: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={img.previewUrl}
            alt=""
            style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
          />
          <button
            onClick={() => onRemoveImage(i)}
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
      ))}
    </div>
  );
}
