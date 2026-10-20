"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ChevronUp, File, Folder, GripVertical, Paperclip, Square } from "lucide-react";
import type { AttachedImage } from "./chat-input/types";
import { AttachmentPreview } from "./chat-input/AttachmentPreview";
import {
  buildSlashCommandItems,
  getSlashTriggerQuery,
  type SlashCommandItem,
  type SlashSkill,
} from "@/lib/slash-commands";

const MAX_HEIGHT = 200;

interface FileSuggestion {
  path: string;
  isDir: boolean;
}

interface MentionToken {
  start: number;
  caret: number;
  query: string;
}

function detectMention(text: string, caret: number): MentionToken | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const previous = at > 0 ? before[at - 1] : "";
  // `@` must start a token (not an email address / mid-word).
  if (previous && !/[\s([{"'`]/.test(previous)) return null;
  const query = before.slice(at + 1);
  if (/[\s\n]/.test(query) || query.length > 120) return null;
  return { start: at, caret, query };
}

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
  cwd,
  queuedFollowUps = [],
  queueBusy = false,
  onReorderFollowUps,
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
  /** Project root used by the `@` file mention menu. */
  cwd?: string | null;
  queuedFollowUps?: Array<{ id: string; message: string; attachmentCount?: number }>;
  queueBusy?: boolean;
  onReorderFollowUps?: (orderedIds: string[]) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const imagesRef = useRef<AttachedImage[]>([]);
  imagesRef.current = images;

  const [mention, setMention] = useState<MentionToken | null>(null);
  const [suggestions, setSuggestions] = useState<FileSuggestion[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [draggingQueueId, setDraggingQueueId] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [slashSkills, setSlashSkills] = useState<SlashSkill[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissedValue, setSlashDismissedValue] = useState<string | null>(null);

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

  // `@` mention suggestions (debounced, abortable). Empty queries browse root.
  useEffect(() => {
    if (!mention || !cwd) {
      setSuggestions([]);
      setSuggestionIndex(0);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(mention.query)}`,
        { signal: controller.signal },
      )
        .then((res) => res.json())
        .then((data: { matches?: FileSuggestion[] }) => {
          setSuggestions(data.matches ?? []);
          setSuggestionIndex(0);
        })
        .catch(() => {
          /* aborted or offline: keep the composer usable */
        });
    }, mention.query ? 140 : 0);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [mention, cwd]);

  const syncMention = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const position = el.selectionStart ?? value.length;
    setCaret(position);
    setMention(detectMention(value, position));
  }, [value]);

  const slashQuery = useMemo(
    () => getSlashTriggerQuery(value, caret),
    [value, caret],
  );
  const slashItems = useMemo(
    () => (slashQuery === null ? [] : buildSlashCommandItems(slashQuery, slashSkills)),
    [slashQuery, slashSkills],
  );
  const slashMenuOpen =
    slashQuery !== null &&
    slashDismissedValue !== value &&
    slashItems.length > 0 &&
    !mention;

  useEffect(() => {
    if (slashQuery === null || !cwd) return;
    const controller = new AbortController();
    fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { skills?: SlashSkill[] }) => setSlashSkills(data.skills ?? []))
      .catch(() => {
        /* keep built-ins available even if skills fail to load */
      });
    return () => controller.abort();
  }, [cwd, slashQuery]);

  useEffect(() => {
    setSlashIndex((index) => (index >= slashItems.length ? 0 : index));
  }, [slashItems.length]);

  const applySlashItem = useCallback(
    (item: SlashCommandItem) => {
      const el = textareaRef.current;
      const after = el ? value.slice(el.selectionStart ?? value.length) : "";
      const next = `${item.insertText}${after.replace(/^\S*/, "")}`;
      onValueChange(next);
      setSlashDismissedValue(null);
      setCaret(item.insertText.length);
      requestAnimationFrame(() => {
        const area = textareaRef.current;
        if (!area) return;
        area.focus();
        area.setSelectionRange(item.insertText.length, item.insertText.length);
      });
    },
    [onValueChange, value],
  );

  const applySuggestion = useCallback(
    (suggestion: FileSuggestion) => {
      if (!mention) return;
      const insert = `@${suggestion.path}${suggestion.isDir ? "/" : " "}`;
      const next = `${value.slice(0, mention.start)}${insert}${value.slice(mention.caret)}`;
      onValueChange(next);
      setMention(null);
      setSuggestions([]);
      const caret = mention.start + insert.length;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [mention, onValueChange, value],
  );

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
  const mentionOpen = mention !== null && suggestions.length > 0;

  const clearInput = () => {
    onValueChange("");
    setImages([]);
    setMention(null);
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

  const moveQueueItem = (id: string, targetIndex: number) => {
    if (!onReorderFollowUps || queueBusy) return;
    const currentIndex = queuedFollowUps.findIndex((item) => item.id === id);
    if (currentIndex === -1) return;
    const clamped = Math.max(0, Math.min(queuedFollowUps.length - 1, targetIndex));
    if (clamped === currentIndex) return;
    const orderedIds = queuedFollowUps.map((item) => item.id);
    orderedIds.splice(currentIndex, 1);
    orderedIds.splice(clamped, 0, id);
    onReorderFollowUps(orderedIds);
  };

  const executeSlashItem = (item: SlashCommandItem) => {
    // Fixed built-in commands execute on Enter; skills insert their trigger so
    // the user can add arguments before sending.
    if (item.kind === "command" && !busy && onSubmit) {
      onSubmit(item.label);
      onValueChange("");
      setMention(null);
      setSlashDismissedValue(item.insertText);
      textareaRef.current?.focus();
      return;
    }
    applySlashItem(item);
  };

  const dropQueueItem = (targetId: string) => {
    if (!draggingQueueId || !onReorderFollowUps || queueBusy) return;
    if (draggingQueueId === targetId) return;
    const orderedIds = queuedFollowUps.map((item) => item.id).filter((id) => id !== draggingQueueId);
    const targetIndex = orderedIds.indexOf(targetId);
    if (targetIndex === -1) return;
    orderedIds.splice(targetIndex, 0, draggingQueueId);
    onReorderFollowUps(orderedIds);
    setDraggingQueueId(null);
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
              draggable={Boolean(onReorderFollowUps) && !queueBusy}
              onDragStart={(event) => {
                setDraggingQueueId(item.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-piforge-follow-up", item.id);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropQueueItem(item.id);
              }}
              onDragEnd={() => setDraggingQueueId(null)}
              className={`flex items-center gap-1.5 rounded-md bg-[#F5F7FA] px-2 py-1 text-[11px] text-ink-muted transition-opacity ${
                draggingQueueId === item.id ? "opacity-40" : ""
              }`}
            >
              {onReorderFollowUps && (
                <GripVertical
                  size={11}
                  strokeWidth={2}
                  className="shrink-0 cursor-grab text-ink-faint"
                  aria-hidden="true"
                />
              )}
              <span className="shrink-0 text-ink-faint">队列 {index + 1}</span>
              <span className="min-w-0 flex-1 truncate">{item.message}</span>
              {(item.attachmentCount ?? 0) > 0 && (
                <span className="shrink-0 text-ink-faint">📎 {item.attachmentCount}</span>
              )}
              {onReorderFollowUps && (
                <span className="flex shrink-0 items-center">
                  <button
                    type="button"
                    onClick={() => moveQueueItem(item.id, index - 1)}
                    disabled={queueBusy || index === 0}
                    aria-label={`上移队列消息 ${index + 1}`}
                    className="flex h-5 w-5 items-center justify-center rounded text-ink-faint hover:bg-[#ECECEF] hover:text-ink disabled:opacity-30"
                  >
                    <ChevronUp size={11} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveQueueItem(item.id, index + 1)}
                    disabled={queueBusy || index === queuedFollowUps.length - 1}
                    aria-label={`下移队列消息 ${index + 1}`}
                    className="flex h-5 w-5 items-center justify-center rounded text-ink-faint hover:bg-[#ECECEF] hover:text-ink disabled:opacity-30"
                  >
                    <ChevronDown size={11} strokeWidth={2} />
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="relative">
        {slashMenuOpen && (
          <div
            role="listbox"
            aria-label="斜杠命令"
            className="material-popover absolute bottom-full left-0 right-0 z-[400] mb-1.5 max-h-60 overflow-y-auto rounded-lg p-1"
          >
            {slashItems.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === slashIndex}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySlashItem(item);
                }}
                onMouseEnter={() => setSlashIndex(index)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ${
                  index === slashIndex
                    ? "bg-[#E8EFFB] text-ink"
                    : "text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
                }`}
              >
                <span className="shrink-0 font-mono text-[12px] font-medium text-ink">{item.label}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">{item.description}</span>
                <span className="shrink-0 rounded bg-[#EDF3FD] px-1 py-0.5 text-[9px] uppercase text-accent-strong">
                  {item.kind}
                </span>
              </button>
            ))}
          </div>
        )}
        {mentionOpen && (
          <div
            role="listbox"
            aria-label="文件引用建议"
            className="material-popover absolute bottom-full left-0 right-0 z-[400] mb-1.5 max-h-56 overflow-y-auto rounded-lg p-1"
          >
            {suggestions.map((suggestion, index) => (
              <button
                key={suggestion.path}
                type="button"
                role="option"
                aria-selected={index === suggestionIndex}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySuggestion(suggestion);
                }}
                onMouseEnter={() => setSuggestionIndex(index)}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] ${
                  index === suggestionIndex
                    ? "bg-[#E8EFFB] text-ink"
                    : "text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
                }`}
              >
                {suggestion.isDir ? (
                  <Folder size={12} strokeWidth={1.75} className="shrink-0 text-accent" aria-hidden="true" />
                ) : (
                  <File size={12} strokeWidth={1.75} className="shrink-0 text-ink-faint" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{suggestion.path}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            onValueChange(e.target.value);
            setSlashDismissedValue(null);
            const position = e.target.selectionStart ?? e.target.value.length;
            setCaret(position);
            setMention(detectMention(e.target.value, position));
          }}
          onKeyUp={syncMention}
          onClick={syncMention}
          onBlur={() => setTimeout(() => setMention(null), 120)}
          onKeyDown={(e) => {
            if (slashMenuOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIndex((index) => (index + 1) % slashItems.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIndex((index) => (index - 1 + slashItems.length) % slashItems.length);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const item = slashItems[slashIndex];
                if (item) executeSlashItem(item);
                return;
              }
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                const item = slashItems[slashIndex];
                if (item) applySlashItem(item);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlashDismissedValue(value);
                return;
              }
            }
            if (mentionOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSuggestionIndex((index) => (index + 1) % suggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                e.preventDefault();
                const selected = suggestions[suggestionIndex];
                if (selected) applySuggestion(selected);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
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
          placeholder="问点什么，或者描述你想构建的东西…（@ 引用文件）"
          aria-label="输入消息"
          className="block w-full resize-none bg-transparent px-2 pt-1.5 text-[15px] leading-6 text-ink caret-accent outline-none placeholder:text-ink-faint"
        />
      </div>
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
              : "Enter 发送 · Shift + Enter 换行 · @ 引用文件"}
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
