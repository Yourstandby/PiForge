"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, FolderPlus, Loader2, X } from "lucide-react";
import { pickDirectoryFromHost } from "./helpers";

type Mode = "choice" | "create";

/**
 * 「新建项目」面板。
 *
 * 两个入口：
 *   选择现有文件夹 → 系统目录选择器，选中后直接加入左侧项目列表
 *   创建新文件夹   → 输入名称 + 选父目录，在磁盘上建好后加入列表
 */
export function NewProjectModal({
  open,
  onClose,
  onAddProject,
}: {
  open: boolean;
  onClose: () => void;
  /** 把最终的项目目录加入左侧列表（由 SessionSidebar 负责持久化）。 */
  onAddProject: (cwd: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("choice");
  const [name, setName] = useState("");
  const [parentDir, setParentDir] = useState("");
  const [busy, setBusy] = useState<"pick" | "browse" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setMode("choice");
    setName("");
    setParentDir("");
    setBusy(null);
    setError(null);
  }, [open]);

  const pickExisting = useCallback(async () => {
    setError(null);
    setBusy("pick");
    try {
      const picked = await pickDirectoryFromHost();
      if (picked?.trim()) {
        onAddProject(picked.trim());
        onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法打开文件夹选择器");
    } finally {
      setBusy(null);
    }
  }, [onAddProject, onClose]);

  const browseParent = useCallback(async () => {
    setError(null);
    setBusy("browse");
    try {
      const picked = await pickDirectoryFromHost();
      if (picked?.trim()) setParentDir(picked.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法打开文件夹选择器");
    } finally {
      setBusy(null);
    }
  }, []);

  const createFolder = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("请输入项目名称");
      return;
    }
    if (!parentDir) {
      setError("请先选择父级目录");
      return;
    }
    setError(null);
    setBusy("create");
    try {
      const response = await fetch("/api/projects/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentDir, name: trimmed }),
      });
      const data = (await response.json().catch(() => null)) as
        | { path?: string; error?: string }
        | null;
      if (!response.ok || !data?.path) {
        throw new Error(data?.error || `创建失败（HTTP ${response.status}）`);
      }
      onAddProject(data.path);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建失败");
    } finally {
      setBusy(null);
    }
  }, [name, parentDir, onAddProject, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-project-title"
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/30 p-4"
      onPointerDown={(event) => {
        // 点遮罩关闭；点卡片内部不关
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="flex w-[400px] max-w-[92vw] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_80px_-24px_rgb(17_17_17_/_0.28)]"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[#EBEDF1] px-4 py-2.5">
          <span id="new-project-title" className="text-[12.5px] font-semibold text-ink">
            {mode === "choice" ? "新建项目" : "创建新文件夹"}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-[#ECECEF] hover:text-ink"
          >
            <X size={14} strokeWidth={1.9} />
          </button>
        </div>

        {mode === "choice" ? (
          <div className="flex flex-col gap-2 p-3">
            <button
              type="button"
              onClick={() => void pickExisting()}
              disabled={busy !== null}
              className="flex items-start gap-3 rounded-xl border border-[#E7E9EE] px-3 py-2.5 text-left transition-colors hover:border-[#C9DCFB] hover:bg-[#F5F9FF] disabled:opacity-60"
            >
              <FolderOpen size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-accent-strong" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium text-ink">选择现有文件夹</span>
                <span className="mt-0.5 block text-[11px] text-ink-faint">打开已有的本地代码仓库</span>
              </span>
              {busy === "pick" && <Loader2 size={13} className="ml-auto mt-1 shrink-0 animate-spin text-ink-faint" aria-hidden="true" />}
            </button>

            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode("create");
              }}
              disabled={busy !== null}
              className="flex items-start gap-3 rounded-xl border border-[#E7E9EE] px-3 py-2.5 text-left transition-colors hover:border-[#C9DCFB] hover:bg-[#F5F9FF] disabled:opacity-60"
            >
              <FolderPlus size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-accent-strong" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium text-ink">创建新文件夹</span>
                <span className="mt-0.5 block text-[11px] text-ink-faint">输入名称和位置新建一个空项目</span>
              </span>
            </button>

            {error && <p className="px-1 text-[11px] text-[#C2554E]">{error}</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-3 p-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-ink-muted">项目名称</span>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createFolder();
                }}
                placeholder="my-new-project"
                className="h-8 rounded-md border border-[#E1E6F0] px-2 text-[12.5px] text-ink outline-none focus:border-accent"
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-ink-muted">位置</span>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={parentDir}
                  placeholder="点击右侧按钮选择父级目录"
                  className="h-8 min-w-0 flex-1 truncate rounded-md border border-[#E1E6F0] px-2 text-[12px] text-ink-muted outline-none"
                  title={parentDir || undefined}
                />
                <button
                  type="button"
                  onClick={() => void browseParent()}
                  disabled={busy !== null}
                  className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-[#E1E6F0] px-2.5 text-[12px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-60"
                >
                  {busy === "browse" ? (
                    <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <FolderOpen size={12} strokeWidth={1.9} aria-hidden="true" />
                  )}
                  浏览
                </button>
              </div>
            </div>

            {error && <p className="text-[11px] text-[#C2554E]">{error}</p>}

            <div className="mt-1 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setMode("choice");
                }}
                className="rounded-md px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
              >
                返回
              </button>
              <button
                type="button"
                onClick={() => void createFolder()}
                disabled={busy !== null || !name.trim() || !parentDir}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy === "create" && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                创建
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default NewProjectModal;
