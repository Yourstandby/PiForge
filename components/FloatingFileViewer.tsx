"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Eye, EyeOff, Loader2, Pencil, Save, WrapText, X } from "lucide-react";
import { syntaxThemeFor } from "@/lib/syntax-theme";
import { encodeFilePathForApi, getFileName, getRelativeFilePath } from "@/lib/file-paths";

export interface FloatingFileTarget {
  filePath: string;
  fileName: string;
  line?: number;
  /** Open the Git working-tree diff instead of the file contents. */
  diff?: boolean;
}

interface FileData {
  content: string;
  language: string;
  size: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FloatingFileViewer({
  target,
  cwd,
  onClose,
}: {
  target: FloatingFileTarget;
  cwd?: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<FileData | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [wrap, setWrap] = useState(false);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setDiff(null);
    setEditing(false);
    setPreview(false);
    const relative = getRelativeFilePath(target.filePath, cwd ?? undefined);

    if (target.diff) {
      fetch(
        `/api/git/diff?cwd=${encodeURIComponent(cwd ?? "")}&path=${encodeURIComponent(relative)}`,
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
          if (!cancelled) setLoading(false);
        });
    } else {
      fetch(`/api/files/${encodeFilePathForApi(target.filePath)}?type=read`)
        .then((res) => res.json())
        .then((body: FileData & { error?: string }) => {
          if (cancelled) return;
          if (body.error) setError(body.error);
          else setData(body);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [target.filePath, target.diff, cwd]);

  const lines = useMemo(() => (data?.content ?? "").split("\n"), [data?.content]);

  useEffect(() => {
    if (!target.line || !data || editing || preview || target.diff) return;
    const targetLine = Math.max(1, Math.min(target.line, lines.length));
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const node = scrollRef.current?.querySelector<HTMLElement>(
          `[data-line="${targetLine}"]`,
        );
        node?.scrollIntoView({ block: "center" });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [target.line, target.diff, data, editing, preview, lines.length]);

  const startEditing = () => {
    if (!data) return;
    setPreview(false);
    setEditContent(data.content);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setEditContent("");
  };

  const save = async () => {
    if (!data || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/files/${encodeFilePathForApi(target.filePath)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      const body = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData({
        ...data,
        content: editContent,
        size: new Blob([editContent]).size,
      });
      setEditing(false);
      setEditContent("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const fileName = target.fileName || getFileName(target.filePath);
  const language = target.diff ? "diff" : (data?.language ?? "text");
  const isMarkdown =
    data?.language === "markdown" || /\.(md|markdown)$/i.test(fileName);

  return (
    <div className="absolute left-2 right-2 top-2 z-30 flex h-[80%] min-h-[220px] flex-col overflow-hidden rounded-lg border border-gray-200/80 bg-white shadow-xl">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-gray-200/70 bg-white px-2">
        <span className="min-w-0 truncate text-[11px] font-medium text-ink" title={target.filePath}>
          {fileName}
        </span>
        <span className="shrink-0 text-[10px] text-ink-faint">· {language}</span>
        {!target.diff && data && (
          <>
            <span className="shrink-0 text-[10px] text-ink-faint">· {lines.length} 行</span>
            <span className="shrink-0 text-[10px] text-ink-faint">· {formatSize(data.size)}</span>
          </>
        )}
        <span className="flex-1" />
        {!target.diff && !editing && (
          <button
            type="button"
            onClick={startEditing}
            disabled={!data || loading}
            title="编辑文件"
            className="flex h-6 items-center gap-1 rounded px-1.5 text-[10.5px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-40"
          >
            <Pencil size={11} strokeWidth={1.9} aria-hidden="true" />
            编辑
          </button>
        )}
        {isMarkdown && !editing && !target.diff && (
          <button
            type="button"
            onClick={() => setPreview((value) => !value)}
            disabled={!data || loading}
            title={preview ? "切换到源码" : "预览 Markdown"}
            aria-pressed={preview}
            className={`flex h-6 items-center gap-1 rounded px-1.5 text-[10.5px] transition-colors disabled:opacity-40 ${
              preview
                ? "bg-[#E8EFFB] font-medium text-accent-strong"
                : "text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
            }`}
          >
            {preview ? (
              <EyeOff size={11} strokeWidth={1.9} aria-hidden="true" />
            ) : (
              <Eye size={11} strokeWidth={1.9} aria-hidden="true" />
            )}
            {preview ? "源码" : "预览"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setWrap((value) => !value)}
          aria-pressed={wrap}
          title={wrap ? "关闭自动换行" : "开启自动换行"}
          className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
            wrap ? "bg-[#E8EFFB] text-accent-strong" : "text-ink-faint hover:bg-[#ECECEF] hover:text-ink"
          }`}
        >
          <WrapText size={12} strokeWidth={1.9} aria-hidden="true" />
        </button>
        {editing && (
          <>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="flex h-6 items-center gap-1 rounded bg-accent px-2 text-[10.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} strokeWidth={2} />}
              保存
            </button>
            <button
              type="button"
              onClick={cancelEditing}
              disabled={saving}
              className="flex h-6 items-center rounded border border-gray-200 bg-[#F5F5F7] px-2 text-[10.5px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-50"
            >
              取消
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭文件预览"
          title="关闭"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-[#ECECEF] hover:text-ink"
        >
          <X size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-[#FBFCFE]">
        {loading ? (
          <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-ink-faint">
            <Loader2 size={11} className="animate-spin" aria-hidden="true" /> 读取文件…
          </p>
        ) : error ? (
          <p className="px-3 py-2 text-[11px] text-danger">{error}</p>
        ) : editing ? (
          <textarea
            value={editContent}
            onChange={(event) => setEditContent(event.target.value)}
            rows={1}
            spellCheck={false}
            className="block h-full min-h-0 w-full resize-none bg-[#FBFCFE] px-3 py-2 font-mono text-[12px] leading-5 text-ink outline-none"
            style={{ boxSizing: "border-box", overflow: "auto", tabSize: 2 }}
          />
        ) : preview && isMarkdown && data ? (
          <div
            className="markdown-body markdown-file-preview"
            style={{ padding: "16px 18px", maxWidth: 860, margin: "0 auto" }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.content}</ReactMarkdown>
          </div>
        ) : target.diff ? (
          <pre className="m-0 py-1 font-mono text-[11.5px] leading-5">
            {(diff ?? "").split(/\r?\n/).map((line, index) => {
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
        ) : data ? (
          <SyntaxHighlighter
            language={data.language === "text" ? "plaintext" : data.language}
            style={syntaxThemeFor("light")}
            showLineNumbers
            wrapLines
            lineProps={(lineNumber: number) => ({
              "data-line": lineNumber,
              style: lineNumber === target.line ? { background: "#FFF6D8" } : undefined,
            })}
            lineNumberStyle={{
              color: "var(--text-dim)",
              fontStyle: "normal",
              minWidth: "3em",
              paddingRight: "1em",
            }}
            customStyle={{
              margin: 0,
              padding: "10px 0",
              background: "#FBFCFE",
              fontSize: 12,
              lineHeight: 1.6,
              fontFamily: "var(--font-mono)",
              minHeight: "100%",
            }}
            codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
            wrapLongLines={wrap}
          >
            {data.content}
          </SyntaxHighlighter>
        ) : null}
      </div>
    </div>
  );
}

export default FloatingFileViewer;
