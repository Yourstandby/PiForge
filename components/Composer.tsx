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
  onStop,
  busy = false,
  disabled = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit?: (value: string, images?: AttachedImage[]) => void;
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
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

  const submit = () => {
    if (!canSend || busy) return;
    onSubmit?.(value.trim(), images.length > 0 ? images : undefined);
    onValueChange("");
    setImages([]);
    textareaRef.current?.focus();
  };

  return (
    <div className="w-full rounded-2xl border border-[#E4E4E0] bg-white p-2.5 shadow-sm transition-all duration-200 focus-within:border-[#BFD4FD] focus-within:shadow-md">
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
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
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
            <Paperclip size={14} strokeWidth={1.75} />
          </button>
          <span className="text-[11px] text-ink-faint">
            Enter 发送 · Shift + Enter 换行
          </span>
        </div>
        {busy && onStop ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="停止生成"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white transition-colors duration-150 hover:bg-accent-strong"
          >
            <Square size={10} strokeWidth={0} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="发送"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white transition-colors duration-150 hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-[#E9E9E5] disabled:text-ink-faint"
          >
            <ArrowUp size={15} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}

export default Composer;
