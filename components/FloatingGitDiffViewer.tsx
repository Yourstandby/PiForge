"use client";

import { useEffect, useState } from "react";
import { GitCompare, Loader2, X } from "lucide-react";

interface GitStatusFile {
  path: string;
  status: string;
  index: string;
  worktree: string;
}

function statusLabel(status: string): string {
  const code = status.replace(/\s+/g, "");
  if (code === "??") return "U";
  if (code.startsWith("D")) return "D";
  if (code.startsWith("A")) return "A";
  if (code.startsWith("R")) return "R";
  return "M";
}

function statusColor(status: string): string {
  const label = statusLabel(status);
  if (label === "U") return "#2563EB";
  if (label === "D") return "#C2554E";
  if (label === "A") return "#3E8A63";
  if (label === "R") return "#7C5BD6";
  return "#B7791F";
}

export function FloatingGitDiffViewer({
  cwd,
  onClose,
}: {
  cwd?: string | null;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<GitStatusFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd) {
      setError("缺少项目路径");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)
      .then((res) => res.json())
      .then((body: { files?: GitStatusFile[]; error?: string }) => {
        if (cancelled) return;
        if (body.error) {
          setError(body.error);
          return;
        }
        const next = body.files ?? [];
        setFiles(next);
        setSelected((current) =>
          current && next.some((file) => file.path === current)
            ? current
            : (next[0]?.path ?? null),
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    if (!cwd || !selected) {
      setDiff("");
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    fetch(
      `/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(selected)}`,
    )
      .then((res) => res.json())
      .then((body: { diff?: string; error?: string }) => {
        if (cancelled) return;
        if (body.error) setError(body.error);
        else setDiff(body.diff ?? "");
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, selected]);

  return (
    <div className="absolute left-2 right-2 top-2 z-30 flex h-[80%] min-h-[220px] flex-col overflow-hidden rounded-lg border border-gray-200/80 bg-white shadow-xl">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-gray-200/70 bg-white px-2">
        <GitCompare size={13} strokeWidth={1.9} className="shrink-0 text-accent-strong" aria-hidden="true" />
        <span className="shrink-0 text-[11px] font-medium text-ink">Git Diff</span>
        <span className="shrink-0 text-[10px] text-ink-faint">· {files.length} 个改动文件</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭 Git Diff"
          title="关闭"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-[#ECECEF] hover:text-ink"
        >
          <X size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {files.length > 0 && (
        <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-gray-200/70 bg-[#FBFCFE] px-1.5">
          {files.map((file) => {
            const active = file.path === selected;
            return (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelected(file.path)}
                title={file.path}
                className={`flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10.5px] transition-colors ${
                  active
                    ? "bg-[#E8EFFB] text-accent-strong"
                    : "text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
                }`}
              >
                <span
                  className="font-mono text-[9px] font-bold"
                  style={{ color: statusColor(file.status) }}
                >
                  {statusLabel(file.status)}
                </span>
                <span className="max-w-[170px] truncate">{file.path}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto bg-[#FBFCFE]">
        {loading ? (
          <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-ink-faint">
            <Loader2 size={11} className="animate-spin" aria-hidden="true" /> 读取 Git 状态…
          </p>
        ) : error ? (
          <p className="px-3 py-2 text-[11px] text-danger">{error}</p>
        ) : files.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-ink-faint">工作区没有未提交改动。</p>
        ) : diffLoading ? (
          <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-ink-faint">
            <Loader2 size={11} className="animate-spin" aria-hidden="true" /> 读取 Diff…
          </p>
        ) : !diff.trim() ? (
          <p className="px-3 py-2 text-[11px] text-ink-faint">该文件没有可显示的文本差异。</p>
        ) : (
          <pre className="m-0 py-1 font-mono text-[11.5px] leading-5">
            {diff.split(/\r?\n/).map((line, index) => {
              const tone =
                line.startsWith("+++") || line.startsWith("---")
                  ? "text-ink-faint"
                  : line.startsWith("+")
                    ? "bg-[#EAF6EE] text-[#256B45]"
                    : line.startsWith("-")
                      ? "bg-[#FBEDEC] text-[#B0443C]"
                      : line.startsWith("@@")
                        ? "text-[#3B6DB5]"
                        : "text-ink-soft";
              return (
                <div key={index} className={`whitespace-pre-wrap break-all px-3 ${tone}`}>
                  {line || " "}
                </div>
              );
            })}
          </pre>
        )}
      </div>
    </div>
  );
}

export default FloatingGitDiffViewer;
