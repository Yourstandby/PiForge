"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Paperclip, Square } from "lucide-react";
import type { AttachedImage } from "./chat-input/types";
import { AttachmentPreview } from "./chat-input/AttachmentPreview";

const MAX_HEIGHT = 200;

function fileToAttachment(file: File): Promise<AttachedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(",");
      const meta = dataUrl.slice(0, comma);
      const mimeType = meta.slice(meta.indexOf(":") + 1, meta.indexOf(";")) || file.type;
      resolve({
        data: dataUrl.slice(comma + 1),
        mimeType,
        previewUrl: URL.createObjectURL(file),
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

export function Composer({
  value = "",
  onValueChange,
  onSubmit,
  onSteer,
  onFollowUp,
  onStop,
  busy = false,
  disabled = false,
  queuedFollowUps = [],
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit?: (value: string, images?: AttachedImage[]) => void;
  /** Enter while the agent is streaming: interrupt and deliver immediately. */
  onSteer?: (value: string, images?: AttachedImage[]) => void;
  /** Alt+Enter while the agent is streaming: append to the follow-up queue. */
  onFollowUp?: (value: string, images?: AttachedImage[]) => void;
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
  queuedFollowUps?: Array<{ id: string; message: string }>;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const imagesRef = useRef<AttachedImage[]>([]);
  imagesRef.current = images;

  useEffect(() => {
    return () => {
      imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
    };
  }, []);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const picked = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (picked.length === 0) return;
    try {
      const attachments = await Promise.all(picked.map(fileToAttachment));
      setImages((current) => [...current, ...attachments]);
    } catch {
      // Silent: an unreadable image should not block typing.
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((current) => {
      const next = [...current];
      const [removed] = next.splice(index, 1);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  }, []);

  const canSend = (value.trim().length > 0 || images.length > 0) && !disabled;

  const clearInput = () => {
    onValueChange("");
    setImages([]);
    textareaRef.current?.focus();
  };

  // Enter: send when idle, steer when streaming. Alt+Enter: queue a follow-up
  // when streaming (plain send when idle, so the shortcut never traps input).
  const submit = (mode: "send" | "steer" | "follow-up" = "send") => {
    if (!canSend) return;
    const text = value.trim();
    const attached = images.length > 0 ? images : undefined;
    if (busy) {
      if (mode === "follow-up") {
        if (!onFollowUp) return;
        onFollowUp(text, attached);
      } else {
        if (!onSteer) return;
        onSteer(text, attached);
      }
    } else {
      if (!onSubmit) return;
      onSubmit(text, attached);
    }
    clearInput();
  };

  return (
    <div className="w-full rounded-2xl border-none bg-white p-2.5 shadow-[0_8px_30px_rgb(0,0,0,0.04)] ring-1 ring-black/[0.03] transition-all duration-200 ease-in-out focus-within:ring-2 focus-within:ring-accent/15 focus-within:shadow-[0_10px_38px_rgb(0,0,0,0.07)]">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {images.length > 0 && (
        <div className="px-1 pb-1.5">
          <AttachmentPreview
            attachedImages={images}
            onRemoveImage={(index) => removeImage(index)}
          />
        </div>
      )}
      {queuedFollowUps.length > 0 && (
        <div className="mb-1 flex flex-col gap-1 px-1" aria-label="待执行的后续消息">
          {queuedFollowUps.map((item, index) => (
            <div
              key={item.id}
              className="flex items-center gap-1.5 rounded-md bg-[#F5F7FA] px-2 py-1 text-[11px] text-ink-muted"
            >
              <span className="shrink-0 text-ink-faint">队列 {index + 1}</span>
              <span className="truncate">{item.message}</span>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit(busy && e.altKey ? "follow-up" : "send");
          }
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (files.some((file) => file.type.startsWith("image/"))) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
        rows={1}
        placeholder="问点什么，或者描述你想构建的东西…"
        aria-label="输入消息"
        className="block w-full resize-none bg-transparent px-2 pt-1.5 text-[15px] leading-6 text-ink caret-accent outline-none placeholder:text-ink-faint"
      />
      <div className="mt-1 flex items-center justify-between px-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label="添加附件"
            title="添加图片附件"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Paperclip size={15} strokeWidth={1.5} />
          </button>
          <span className="text-[11px] text-ink-faint">
            {busy
              ? "Enter 打断并发送 · Alt + Enter 加入队列"
              : "Enter 发送 · Shift + Enter 换行"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {busy && canSend && onSteer && (
            <button
              type="button"
              onClick={() => submit("steer")}
              aria-label="打断并发送"
              title="打断当前回复并立即发送"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white transition-colors duration-150 hover:bg-accent-strong"
            >
              <ArrowUp size={15} strokeWidth={2.5} />
            </button>
          )}
          {busy && onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="停止生成"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white transition-colors duration-150 hover:bg-accent-strong"
            >
              <Square size={10} strokeWidth={0} fill="currentColor" />
            </button>
          ) : !busy ? (
            <button
              type="button"
              onClick={() => submit("send")}
              disabled={!canSend}
              aria-label="发送"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white transition-colors duration-150 hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-[#E9E9E5] disabled:text-ink-faint"
            >
              <ArrowUp size={15} strokeWidth={2.5} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default Composer;
