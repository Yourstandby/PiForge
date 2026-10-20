"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  FilePlus2,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { diffStats, parseUnifiedDiff, type DiffLine } from "@/lib/diff-lines";
import { DiffRow } from "./DiffRows";

/**
 * Git tab: working-tree status, per-file diff and a commit box.
 *
 * Backed by the existing thin git helpers (`/api/git/status`, `/api/git/diff`)
 * plus `/api/git/commit` → `git add -A` + `git commit -m`. Diffs are parsed by
 * lib/diff-lines.ts and rendered with plain rows: no Monaco, no diff library.
 */

interface GitStatusFile {
  path: string;
  status: string;
  index: string;
  worktree: string;
}

interface StatusBody {
  files?: GitStatusFile[];
  repoRoot?: string | null;
  branch?: string | null;
  notGitRepo?: boolean;
  error?: string;
}

type Toast = { tone: "ok" | "error"; text: string } | null;

/** Same letters the file explorer shows, but colour-coded for this list. */
function statusBadge(file: GitStatusFile): { label: string; color: string; title: string } {
  const code = file.status.replace(/\s+/g, "");
  if (code === "??") return { label: "U", color: "#16A34A", title: "未追踪" };
  if (code.startsWith("D")) return { label: "D", color: "#DC2626", title: "已删除" };
  if (code.startsWith("A")) return { label: "A", color: "#16A34A", title: "新增" };
  if (code.startsWith("R")) return { label: "R", color: "#7C5BD6", title: "重命名" };
  if (code.startsWith("M")) return { label: "M", color: "#2563EB", title: "已修改" };
  if (code.startsWith("U") || code.startsWith("AA") || code.startsWith("DD")) {
    return { label: "!", color: "#DC2626", title: "冲突" };
  }
  return { label: code.slice(0, 1) || "M", color: "#B7791F", title: "改动" };
}

interface DirGroup {
  dir: string;
  files: GitStatusFile[];
}

/** Group files by directory so long paths read as a shallow tree. */
function groupByDirectory(files: GitStatusFile[]): DirGroup[] {
  const groups = new Map<string, GitStatusFile[]>();
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const dir = slash === -1 ? "" : file.path.slice(0, slash);
    const bucket = groups.get(dir);
    if (bucket) bucket.push(file);
    else groups.set(dir, [file]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, groupFiles]) => ({ dir, files: groupFiles }));
}

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Very long diffs are windowed so the DOM stays small. */
const DIFF_HEAD_LIMIT = 900;
const DIFF_TAIL_LIMIT = 900;

function windowDiff(rows: DiffLine[]): { rows: DiffLine[]; skipped: number } {
  if (rows.length <= DIFF_HEAD_LIMIT + DIFF_TAIL_LIMIT) return { rows, skipped: 0 };
  return {
    rows: [...rows.slice(0, DIFF_HEAD_LIMIT), ...rows.slice(rows.length - DIFF_TAIL_LIMIT)],
    skipped: rows.length - DIFF_HEAD_LIMIT - DIFF_TAIL_LIMIT,
  };
}

export function GitPanel({ cwd, active = true }: { cwd: string | null; active?: boolean }) {
  const [files, setFiles] = useState<GitStatusFile[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [notGitRepo, setNotGitRepo] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // null = list view; otherwise the diff for that path.
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((next: NonNullable<Toast>) => {
    setToast(next);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  const loadStatus = useCallback(async () => {
    if (!cwd) {
      setFiles([]);
      setBranch(null);
      setError("缺少项目路径");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const body = (await res.json()) as StatusBody;
      if (body.error) {
        setError(body.error);
        setFiles([]);
        return;
      }
      setError(null);
      setNotGitRepo(body.notGitRepo === true);
      setBranch(body.branch ?? null);
      const next = body.files ?? [];
      setFiles(next);
      setSelected((current) =>
        current && next.some((file) => file.path === current) ? current : null,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Keep the list honest while the agent edits files behind our back — but
  // only while the tab is visible and the window is focused.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void loadStatus();
    }, 12_000);
    return () => window.clearInterval(id);
  }, [active, loadStatus]);

  // Load the diff for the selected file.
  useEffect(() => {
    if (!cwd || !selected) {
      setDiff("");
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(selected)}`, {
      cache: "no-store",
    })
      .then((res) => res.json())
      .then((body: { diff?: string; error?: string }) => {
        if (cancelled) return;
        if (body.error) setDiffError(body.error);
        else setDiff(body.diff ?? "");
      })
      .catch((e: unknown) => {
        if (!cancelled) setDiffError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, selected]);

  const groups = useMemo(() => groupByDirectory(files), [files]);
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const stats = useMemo(() => diffStats(parsed), [parsed]);
  const view = useMemo(() => windowDiff(parsed), [parsed]);
  const selectedFile = selected ? files.find((file) => file.path === selected) ?? null : null;
  const selectedBadge = selectedFile ? statusBadge(selectedFile) : null;

  const commit = useCallback(async () => {
    if (!cwd || committing) return;
    if (!message.trim()) {
      showToast({ tone: "error", text: "请填写提交信息" });
      return;
    }
    setCommitting(true);
    try {
      const res = await fetch("/api/git/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, message }),
      });
      const body = (await res.json()) as { hash?: string | null; error?: string; output?: string };
      if (!res.ok) {
        const detail = (body.output ?? "").split("\n").filter(Boolean).slice(-2).join(" ");
        showToast({ tone: "error", text: body.error ?? (detail || "提交失败") });
        return;
      }
      setMessage("");
      setSelected(null);
      showToast({ tone: "ok", text: body.hash ? `已提交 ${body.hash}` : "已提交" });
      await loadStatus();
    } catch (e) {
      showToast({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setCommitting(false);
    }
  }, [cwd, message, committing, loadStatus, showToast]);

  const canCommit = Boolean(cwd) && !committing && message.trim().length > 0 && files.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* Header: branch + refresh */}
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-gray-200/60 bg-[#F5F5F7] px-2 text-[10.5px] text-ink-faint">
        <GitBranch size={11} strokeWidth={1.9} className="shrink-0" aria-hidden="true" />
        <span className="truncate font-mono" title={branch ?? undefined}>
          {branch ?? (notGitRepo ? "非 Git 仓库" : "—")}
        </span>
        <span className="shrink-0">· {files.length} 个改动</span>
        <button
          type="button"
          onClick={() => void loadStatus()}
          title="刷新 Git 状态"
          aria-label="刷新 Git 状态"
          className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} strokeWidth={2} />}
        </button>
      </div>

      {/* Body: file list or diff */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {selected ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-7 shrink-0 items-center gap-1 border-b border-gray-200/60 bg-white px-1.5">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="flex h-5 items-center gap-0.5 rounded px-1 text-[10.5px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
                title="返回改动列表"
              >
                <ArrowLeft size={11} strokeWidth={2} aria-hidden="true" />
                列表
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink" title={selected}>
                {selectedBadge && (
                  <span
                    className="mr-1 font-bold"
                    style={{ color: selectedBadge.color }}
                    title={selectedBadge.title}
                  >
                    {selectedBadge.label}
                  </span>
                )}
                {baseName(selected)}
              </span>
              {stats.added > 0 && <span className="shrink-0 font-mono text-[10px] text-[#16A34A]">+{stats.added}</span>}
              {stats.removed > 0 && <span className="shrink-0 font-mono text-[10px] text-[#DC2626]">−{stats.removed}</span>}
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-white">
              {diffLoading ? (
                <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-ink-faint">
                  <Loader2 size={11} className="animate-spin" aria-hidden="true" /> 读取 Diff…
                </p>
              ) : diffError ? (
                <p className="px-3 py-2 text-[11px] text-danger">{diffError}</p>
              ) : parsed.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-ink-faint">该文件没有可显示的文本差异（可能是二进制或仅模式变更）。</p>
              ) : (
                <div className="py-0.5">
                  {view.rows.slice(0, DIFF_HEAD_LIMIT).map((row, index) => (
                    <DiffRow key={`h${index}`} row={row} />
                  ))}
                  {view.skipped > 0 && (
                    <p className="my-1 bg-[#F7F8FA] px-2 py-1 text-center text-[10.5px] text-ink-faint">
                      … 省略中间 {view.skipped} 行（可用文件面板查看完整内容）…
                    </p>
                  )}
                  {view.rows.slice(DIFF_HEAD_LIMIT).map((row, index) => (
                    <DiffRow key={`t${index}`} row={row} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="h-full overflow-y-auto">
            {loading && files.length === 0 ? (
              <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-ink-faint">
                <Loader2 size={11} className="animate-spin" aria-hidden="true" /> 读取 Git 状态…
              </p>
            ) : error ? (
              <p className="px-3 py-2 text-[11px] text-danger">{error}</p>
            ) : notGitRepo ? (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
                <GitBranch size={20} strokeWidth={1.4} className="text-ink-faint" aria-hidden="true" />
                <p className="text-[11.5px] text-ink-muted">当前项目不是 Git 仓库</p>
                <p className="text-[10.5px] text-ink-faint">git init 之后这里会显示改动。</p>
              </div>
            ) : files.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
                <Check size={20} strokeWidth={1.6} className="text-[#16A34A]" aria-hidden="true" />
                <p className="text-[11.5px] text-ink-muted">工作区干净</p>
                <p className="text-[10.5px] text-ink-faint">没有未提交的改动。</p>
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.dir || "<root>"} className="py-0.5">
                  <p
                    className="truncate px-2 py-0.5 text-[10px] font-medium text-[#6B7280]"
                    title={group.dir || "."}
                  >
                    {group.dir || "./"}
                  </p>
                  {group.files.map((file) => {
                    const badge = statusBadge(file);
                    return (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => setSelected(file.path)}
                        title={`${badge.title} · ${file.path}`}
                        className="group flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left transition-colors hover:bg-[#E8EFFB]/70"
                      >
                        <span
                          aria-hidden="true"
                          className="w-[11px] shrink-0 text-center font-mono text-[10px] font-bold"
                          style={{ color: badge.color }}
                        >
                          {badge.label}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[#374151]">
                          {baseName(file.path)}
                        </span>
                        <ChevronRight
                          size={10}
                          strokeWidth={2}
                          aria-hidden="true"
                          className="shrink-0 text-transparent transition-colors group-hover:text-ink-faint"
                        />
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Commit box */}
      <div className="relative shrink-0 border-t border-gray-200/60 bg-[#FAFAFB] p-1.5">
        <div className="flex items-end gap-1">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void commit();
              }
            }}
            rows={2}
            placeholder="提交信息（⌘/Ctrl+Enter 提交）"
            aria-label="提交信息"
            disabled={!cwd || committing}
            className="min-h-[46px] min-w-0 flex-1 resize-none rounded-md border border-[#E7E9EE] bg-white px-1.5 py-1 text-[11.5px] leading-5 text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent/50 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void commit()}
            disabled={!canCommit}
            title={files.length === 0 ? "没有可提交的改动" : "git add -A && git commit"}
            className="flex h-[46px] w-[54px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-md bg-accent text-[10.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {committing ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <GitCommitHorizontal size={13} strokeWidth={2} aria-hidden="true" />
            )}
            提交
          </button>
        </div>
        <p className="mt-1 flex items-center gap-1 text-[10px] text-ink-faint">
          <FilePlus2 size={9} strokeWidth={2} aria-hidden="true" />
          提交会自动暂存全部改动（git add -A）
        </p>

        {toast && (
          <div
            role="status"
            className={`material-popover absolute bottom-full left-1.5 right-1.5 mb-1 flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-[10.5px] shadow-[var(--shadow-popover)] ${
              toast.tone === "ok" ? "text-[#22603D]" : "text-[#A03A32]"
            }`}
          >
            {toast.tone === "ok" ? (
              <Check size={11} strokeWidth={2.4} className="mt-[1px] shrink-0" aria-hidden="true" />
            ) : (
              <TriangleAlert size={11} strokeWidth={2.2} className="mt-[1px] shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 break-words">{toast.text}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default GitPanel;
