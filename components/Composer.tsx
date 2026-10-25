"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ChevronUp, File, Folder, GripVertical, ImagePlus, Paperclip, Square, X } from "lucide-react";
import type { AttachedImage } from "./chat-input/types";
import { processImageFile } from "@/lib/image-attachment";
import { AttachmentPreview } from "./chat-input/AttachmentPreview";
import { buildReferenceInsertion, isImageFileLike } from "@/lib/composer-files";
import { FILE_DRAG_MIME } from "@/lib/file-drag";
import { getElectronApi } from "@/lib/electron-api";
import { getRelativeFilePath } from "@/lib/file-paths";
import {
  pushPromptHistory,
  readPromptHistory,
  stepHistory,
  writePromptHistory,
} from "@/lib/prompt-history";
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

/**
 * 图片附件：先缩到视觉模型的长边上限（1568），再交给会话。
 * 模型看到的信息不变，上传体积与图片 token 数可以降一个量级。
 */
async function fileToAttachment(file: File): Promise<AttachedImage> {
  const processed = await processImageFile(file);
  return {
    data: processed.data,
    mimeType: processed.mimeType,
    previewUrl: URL.createObjectURL(file),
    width: processed.width,
    height: processed.height,
    bytes: processed.bytes,
    originalBytes: processed.originalBytes,
  };
}

/** Drag payload carries files (not a reorder drag of the follow-up queue). */
function hasFilePayload(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes("Files"));
}

/** A file-tree row dragged from the right panel. */
function hasPathPayload(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes(FILE_DRAG_MIME));
}

function hasDragPayload(dataTransfer: DataTransfer | null): boolean {
  return hasFilePayload(dataTransfer) || hasPathPayload(dataTransfer);
}

/**
 * Clipboard files. Screenshots usually arrive in `files`; some apps only expose
 * them as `items[kind=file]`, so both are checked.
 */
function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const direct = Array.from(data.files ?? []);
  if (direct.length > 0) return direct;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

/** Absolute path of a dropped file (Electron only; browsers never expose it). */
function fileSystemPath(file: File): string | null {
  try {
    return getElectronApi()?.getPathForFile?.(file) ?? null;
  } catch {
    return null;
  }
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
  onRemoveFollowUp,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit?: (value: string, images?: AttachedImage[]) => void;
  /** Enter while the agent is streaming: append to the follow-up queue (default, non-interrupting). */
  onFollowUp?: (value: string, images?: AttachedImage[]) => void;
  /** Ctrl/Cmd+Enter while the agent is streaming: interrupt and deliver immediately. */
  onSteer?: (value: string, images?: AttachedImage[]) => void;
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
  /** Project root used by the `@` file mention menu. */
  cwd?: string | null;
  queuedFollowUps?: Array<{ id: string; message: string; attachmentCount?: number }>;
  queueBusy?: boolean;
  onReorderFollowUps?: (orderedIds: string[]) => void;
  /** 删除单条排队消息（交给宿主真正出队，本地只是乐观更新）。 */
  onRemoveFollowUp?: (id: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const imagesRef = useRef<AttachedImage[]>([]);
  imagesRef.current = images;
  const [dragActive, setDragActive] = useState(false);
  // dragenter/leave fire for every child element; count them instead of
  // toggling so the highlight does not flicker.
  const dragDepth = useRef(0);

  // Terminal-style prompt history (↑ / ↓), newest first.
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  // Text the user had typed before starting to browse history.
  const historyDraftRef = useRef("");

  useEffect(() => {
    setHistory(readPromptHistory());
  }, []);

  const rememberPrompt = useCallback((prompt: string) => {
    setHistory((current) => {
      const next = pushPromptHistory(current, prompt);
      writePromptHistory(next);
      return next;
    });
  }, []);

  const focusCaretAtEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const position = el.value.length;
      el.setSelectionRange(position, position);
      setCaret(position);
    });
  }, []);

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
    const picked = Array.from(files).filter((file) => isImageFileLike(file.name, file.type));
    if (picked.length === 0) return;
    try {
      const attachments = await Promise.all(picked.map(fileToAttachment));
      setImages((current) => [...current, ...attachments]);
    } catch {
      // Silent: an unreadable image should not block typing.
    }
  }, []);

  /** Append `@path` references for non-image files. */
  const insertRefs = useCallback(
    (paths: string[]) => {
      const next = buildReferenceInsertion(value, paths);
      if (next === value) return;
      onValueChange(next);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        setCaret(next.length);
        el.setSelectionRange(next.length, next.length);
      });
    },
    [onValueChange, value],
  );

  /** Resolve a dropped/pasted file to a project-relative reference path. */
  const resolveRef = useCallback(
    async (file: File): Promise<string> => {
      const absolute = fileSystemPath(file);
      if (absolute) return cwd ? getRelativeFilePath(absolute, cwd) : absolute;
      // Browser fallback: <input type=file> exposes no path, so look the name up
      // in the project index before settling for the bare filename.
      if (cwd) {
        try {
          const res = await fetch(
            `/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(file.name)}`,
          );
          if (res.ok) {
            const data = (await res.json()) as { matches?: FileSuggestion[] };
            const hit = data.matches?.find(
              (match) => !match.isDir && (match.path === file.name || match.path.endsWith(`/${file.name}`)),
            );
            if (hit) return hit.path;
          }
        } catch {
          // Offline / not indexed: fall back to the filename.
        }
      }
      return file.name;
    },
    [cwd],
  );

  /** Images become attachments, anything else becomes `@path` references. */
  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const imagesPicked = files.filter((file) => isImageFileLike(file.name, file.type));
      const others = files.filter((file) => !isImageFileLike(file.name, file.type));
      if (imagesPicked.length > 0) await addFiles(imagesPicked);
      if (others.length > 0) {
        const paths = await Promise.all(others.map(resolveRef));
        insertRefs(paths);
      }
    },
    [addFiles, resolveRef, insertRefs],
  );

  // A drop outside the composer must never navigate the window to the file.
  useEffect(() => {
    const preventNavigation = (event: DragEvent) => {
      if (hasFilePayload(event.dataTransfer)) event.preventDefault();
    };
    // Safety net: `dragleave` is not guaranteed for every dragenter, so a drag
    // that ends anywhere clears the composer highlight.
    const resetDrag = () => {
      dragDepth.current = 0;
      setDragActive(false);
    };
    window.addEventListener("dragover", preventNavigation);
    window.addEventListener("drop", preventNavigation);
    window.addEventListener("drop", resetDrag);
    window.addEventListener("dragend", resetDrag);
    return () => {
      window.removeEventListener("dragover", preventNavigation);
      window.removeEventListener("drop", preventNavigation);
      window.removeEventListener("drop", resetDrag);
      window.removeEventListener("dragend", resetDrag);
    };
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
    // 发出去之后附件只会以 base64 进会话，缩略图的 Blob URL 必须立刻回收，
    // 否则每贴一张图就永久漏一份整图内存（贴十几张后输入框会明显变卡）。
    setImages((current) => {
      for (const image of current) URL.revokeObjectURL(image.previewUrl);
      return [];
    });
    setMention(null);
    setHistoryIndex(null);
    historyDraftRef.current = "";
    textareaRef.current?.focus();
  };

  // Enter: send when idle, steer when streaming. Alt+Enter: queue a follow-up
  // when streaming (plain send when idle, so the shortcut never traps input).
  const submit = (mode: "send" | "steer" | "follow-up" = "send") => {
    if (!canSend) return;
    const text = value.trim();
    // A bare `/imagine` is an invitation to type a prompt, not a message.
    if (/^\/imagine$/i.test(text)) {
      onValueChange("/imagine ");
      focusCaretAtEnd();
      return;
    }
    const attached = images.length > 0 ? images : undefined;
    if (text) rememberPrompt(text);
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

  /** Insert `@relative/path` at the caret for a file dragged from the tree. */
  const insertPathReference = useCallback(
    (filePath: string) => {
      const relative = cwd ? getRelativeFilePath(filePath, cwd) : filePath;
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? value.length;
      const before = value.slice(0, caret);
      const after = value.slice(caret);
      const prefix = before.length > 0 && !/\s$/.test(before) ? " " : "";
      const insertion = `${prefix}@${relative} `;
      onValueChange(`${before}${insertion}${after}`);
      setMention(null);
      setCaret(caret + insertion.length);
      requestAnimationFrame(() => {
        const area = textareaRef.current;
        if (!area) return;
        const next = caret + insertion.length;
        area.focus();
        area.setSelectionRange(next, next);
      });
    },
    [cwd, onValueChange, value],
  );

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
    <div
      onDragEnter={(event) => {
        if (!hasDragPayload(event.dataTransfer)) return;
        dragDepth.current += 1;
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (!hasDragPayload(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!hasDragPayload(event.dataTransfer)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      }}
      onDrop={(event) => {
        const draggedPath = event.dataTransfer.getData(FILE_DRAG_MIME);
        if (draggedPath) {
          event.preventDefault();
          dragDepth.current = 0;
          setDragActive(false);
          insertPathReference(draggedPath);
          return;
        }
        if (!hasFilePayload(event.dataTransfer)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);
        void handleFiles(Array.from(event.dataTransfer.files));
      }}
      className={`relative w-full shrink-0 rounded-2xl bg-white p-2.5 shadow-[0_2px_12px_rgba(17,17,17,0.05)] ring-1 transition-all duration-200 ease-in-out focus-within:ring-2 ${
        dragActive
          ? "ring-2 ring-accent/40 bg-[#F7FAFF]"
          : "ring-black/[0.05] focus-within:ring-accent/20"
      }`}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent/40 bg-white/85 text-[12px] font-medium text-accent-strong">
          松开以添加图片、文件引用或路径
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleFiles(Array.from(e.target.files));
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
              {onRemoveFollowUp && (
                <button
                  type="button"
                  onClick={() => onRemoveFollowUp(item.id)}
                  disabled={queueBusy}
                  aria-label={`删除队列消息 ${index + 1}`}
                  title="删除队列消息"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-[#FDF2F2] hover:text-[#DC2626] disabled:opacity-30"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="relative min-h-0">
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
            // Typing leaves history browsing; the edited text becomes the draft.
            setHistoryIndex(null);
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
            // ↑ / ↓ walk previously sent prompts when the composer is empty.
            // With text already in the box, ↑ keeps its native caret behavior.
            if ((e.key === "ArrowUp" || e.key === "ArrowDown") && history.length > 0) {
              const browsing = historyIndex !== null;
              if (e.key === "ArrowUp" && (value.length === 0 || browsing)) {
                e.preventDefault();
                if (!browsing) historyDraftRef.current = value;
                const next = stepHistory(historyIndex, "older", history.length);
                setHistoryIndex(next.index);
                onValueChange(history[next.index ?? 0] ?? "");
                focusCaretAtEnd();
                return;
              }
              if (e.key === "ArrowDown" && browsing) {
                e.preventDefault();
                const next = stepHistory(historyIndex, "newer", history.length);
                setHistoryIndex(next.index);
                onValueChange(next.restoreDraft ? historyDraftRef.current : (history[next.index ?? 0] ?? ""));
                focusCaretAtEnd();
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              // 默认排队不打断：busy 时 Enter = 加入队列，Ctrl/Cmd+Enter = 打断并发送。
              submit(busy ? (e.ctrlKey || e.metaKey ? "steer" : "follow-up") : "send");
            }
          }}
          onPaste={(e) => {
            const files = clipboardFiles(e.clipboardData);
            if (files.length === 0) return;
            // Screenshots and copied files: attach images, reference the rest.
            e.preventDefault();
            void handleFiles(files);
          }}
          rows={1}
          placeholder="问点什么，或者描述你想构建的东西…（@ 引用文件）"
          aria-label="输入消息"
          className="block min-h-6 w-full resize-none bg-transparent px-2 pt-1 text-[15px] leading-6 text-ink caret-accent outline-none placeholder:text-ink-faint"
        />
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label="添加附件"
            title="添加附件（图片或文件引用）"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Paperclip size={15} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={() => {
              onValueChange(value.trim() ? `${value.replace(/\s+$/, "")}\n/imagine ` : "/imagine ");
              focusCaretAtEnd();
            }}
            disabled={disabled}
            aria-label="生成图片"
            title="生成图片（/imagine 描述）"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ImagePlus size={15} strokeWidth={1.5} />
          </button>
          {/* 快捷键提示：可伸缩 + 省略号，宽度不够时被截断而不是压住发送按钮 */}
          <span className="hidden min-w-0 flex-1 truncate text-[11px] text-ink-faint sm:block">
            {busy
              ? "Enter 加入队列 · Ctrl + Enter 打断并发送"
              : "Enter 发送 · Shift + Enter 换行 · @ 引用文件 · 拖拽添加"}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
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
