"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Eye, EyeOff, FolderTree, Loader2, Pencil, Save, WrapText, X } from "lucide-react";
import { syntaxThemeFor } from "@/lib/syntax-theme";
import { encodeFilePathForApi, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { ErrorNotice } from "./ErrorNotice";

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

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonl", "css", "scss", "sass",
  "less", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "sh", "bash",
  "zsh", "ps1", "bat", "cmd", "py", "pyi", "go", "rs", "java", "kt", "kts", "swift",
  "c", "cc", "cpp", "cxx", "h", "hpp", "cs", "rb", "php", "sql", "graphql", "gql",
  "txt", "log", "csv", "tsv", "lock", "gitignore", "npmrc", "editorconfig",
  "properties", "gradle", "dockerfile", "makefile", "license", "readme", "notice",
  "changelog", "procfile",
]);

/**
 * Prism 高亮是同步 tokenize：几百 KB 文件会占住主线程数秒，正在流式的回复、
 * 输入框全卡住（看起来就像“对话被中断”）。超过阈值直接降级为纯文本行渲染，
 * 行号 / 目标行高亮都保留；极端行数再截断。
 */
const HIGHLIGHT_MAX_CHARS = 80_000;
const PLAIN_MAX_LINES = 4_000;

type FileKind = "image" | "html" | "markdown" | "text" | "unsupported";

function fileExtension(fileName: string): string {
  return fileName.toLowerCase().split(".").pop() ?? "";
}

function fileKind(fileName: string): FileKind {
  const ext = fileExtension(fileName);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (HTML_EXTENSIONS.has(ext)) return "html";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (ext && !TEXT_EXTENSIONS.has(ext)) return "unsupported";
  return "text";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 纯文本代码渲染：不做任何 tokenize，保留行号与目标行高亮。
 * 用于超过高亮阈值的文件，保证点开文件不会阻塞对话流式渲染。
 */
function PlainCode({
  lines,
  wrap,
  targetLine,
}: {
  lines: string[];
  wrap: boolean;
  targetLine?: number;
}) {
  const truncated = lines.length > PLAIN_MAX_LINES;
  const visible = truncated ? lines.slice(0, PLAIN_MAX_LINES) : lines;
  return (
    <div
      className="min-h-full bg-[#FBFCFE] py-2 font-mono text-[12px] leading-[1.6]"
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {visible.map((line, index) => {
        const lineNumber = index + 1;
        return (
          <div
            key={lineNumber}
            data-line={lineNumber}
            className="flex"
            style={lineNumber === targetLine ? { background: "#FFF6D8" } : undefined}
          >
            <span
              className="shrink-0 select-none pr-3 pl-3 text-right text-ink-faint"
              style={{ minWidth: "3em", color: "var(--text-dim)" }}
            >
              {lineNumber}
            </span>
            <span
              className={
                wrap
                  ? "min-w-0 flex-1 whitespace-pre-wrap break-words pr-3"
                  : "min-w-0 flex-1 whitespace-pre pr-3"
              }
            >
              {line || " "}
            </span>
          </div>
        );
      })}
      {truncated && (
        <p className="px-3 py-2 text-[11px] text-ink-faint">
          文件过大，仅显示前 {PLAIN_MAX_LINES} 行（共 {lines.length} 行）。
        </p>
      )}
    </div>
  );
}

export function FloatingFileViewer({
  target,
  cwd,
  refreshKey = 0,
  onRevealInTree,
  onClose,
}: {
  target: FloatingFileTarget;
  cwd?: string | null;
  /** Bumped after an external write (e.g. applying a code block) to refetch. */
  refreshKey?: number;
  /** 收起浮层预览，改为在右侧文件树里定位这个文件。 */
  onRevealInTree?: (filePath: string) => void;
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

  const fileName = target.fileName || getFileName(target.filePath);
  const kind = fileKind(fileName);
  const isPreviewable = kind === "image" || kind === "html" || kind === "markdown";
  const isTextEditable = kind === "text" || kind === "html" || kind === "markdown";
  const language = target.diff
    ? "diff"
    : kind === "image"
      ? fileExtension(fileName)
      : (data?.language ?? fileExtension(fileName) ?? "text");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setDiff(null);
    setEditing(false);
    setPreview(kind === "image");
    const relative = getRelativeFilePath(target.filePath, cwd ?? undefined);

    const finish = () => {
      if (!cancelled) setLoading(false);
    };

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
        .finally(finish);
    } else if (kind === "image") {
      finish();
    } else if (kind === "unsupported") {
      finish();
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
        .finally(finish);
    }
    return () => {
      cancelled = true;
    };
    // kind derives from target.fileName, covered by filePath changes in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.filePath, target.diff, cwd, refreshKey]);

  const lines = useMemo(() => (data?.content ?? "").split("\n"), [data?.content]);
  /** 过大文件不走 Prism，避免点开瞬间卡住正在流式的对话。 */
  const heavy = !target.diff && (data?.content.length ?? 0) > HIGHLIGHT_MAX_CHARS;

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

  const imageSrc = `/api/files/${encodeFilePathForApi(target.filePath)}?type=read`;

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
        {onRevealInTree && (
          <button
            type="button"
            onClick={() => onRevealInTree(target.filePath)}
            title="在文件树中定位"
            aria-label="在文件树中定位"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-[#ECECEF] hover:text-ink"
          >
            <FolderTree size={12} strokeWidth={1.9} aria-hidden="true" />
          </button>
        )}
        {isTextEditable && !target.diff && !editing && (
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
        {isPreviewable && !editing && !target.diff && (
          <button
            type="button"
            onClick={() => setPreview((value) => !value)}
            disabled={loading}
            title={preview ? "切换到源码" : "预览文件"}
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
        {(isTextEditable || target.diff) && !editing && (
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
        )}
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
          <ErrorNotice message={error} className="block px-3 py-2 text-[11px] text-danger" />
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
        ) : kind === "unsupported" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-[12px] text-ink-muted">
              暂不支持预览此格式，请下载或使用本地软件打开
            </p>
            <p className="font-mono text-[11px] uppercase text-ink-faint">
              {fileExtension(fileName) || "unknown"}
            </p>
          </div>
        ) : editing ? (
          <textarea
            value={editContent}
            onChange={(event) => setEditContent(event.target.value)}
            rows={1}
            spellCheck={false}
            className="block h-full min-h-0 w-full resize-none bg-[#FBFCFE] px-3 py-2 font-mono text-[12px] leading-5 text-ink outline-none"
            style={{ boxSizing: "border-box", overflow: "auto", tabSize: 2 }}
          />
        ) : kind === "image" ? (
          preview ? (
            <div className="flex min-h-full items-center justify-center overflow-auto p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageSrc}
                alt={fileName}
                className="mx-auto block max-w-full"
                style={{ height: "auto" }}
              />
            </div>
          ) : (
            <p className="px-3 py-2 text-[11px] text-ink-faint">
              图片为二进制文件，切换到预览查看。
            </p>
          )
        ) : kind === "html" && preview && data ? (
          <iframe
            sandbox="allow-scripts"
            srcDoc={data.content}
            title={fileName}
            className="h-full w-full border-0 bg-white"
          />
        ) : kind === "markdown" && preview && data ? (
          <div
            className="markdown-body markdown-file-preview"
            style={{ padding: "16px 18px", maxWidth: 860, margin: "0 auto" }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.content}</ReactMarkdown>
          </div>
        ) : data ? (
          heavy ? (
            <PlainCode lines={lines} wrap={wrap} targetLine={target.line} />
          ) : (
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
          )
        ) : null}
      </div>
    </div>
  );
}

export default FloatingFileViewer;
