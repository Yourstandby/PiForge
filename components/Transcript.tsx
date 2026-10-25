"use client";

import { Children, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { BrainCircuit, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, CornerDownLeft, GitBranch, GitFork, Loader2, TriangleAlert, Wrench, X } from "lucide-react";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "@/lib/types";
import { diffStats } from "@/lib/diff-lines";
import { stripImageDimensionNotes } from "@/lib/image-dimension-note";
import { buildWithTurnCache, type TurnCacheEntry } from "@/lib/transcript-turn-cache";
import { isInterventionText } from "@/contract/intervention-marker";
import { estimateTokens } from "@/lib/live-usage";
import type { BranchSwitchInfo } from "@/lib/session-branches-view";
import { isEditToolName, toolDiffPath, toolDiffRows } from "@/lib/tool-diff";
import { ImageLightbox } from "./chat-input/ImageLightbox";
import { useI18n } from "./I18nProvider";
import { useTypedText } from "@/hooks/useSmoothTypewriter";
import { DiffRows } from "./DiffRows";
import { getFileName } from "@/lib/file-paths";
import {
  findFileReferences,
  parseFileReference,
  resolveFileReferencePath,
  resolveHrefFileReference,
  type FileReference,
} from "@/lib/file-links";
import { useToolStall } from "@/hooks/useWatchdogStatus";
import { useWatchdogSessionId } from "./watchdog/WatchdogProvider";
import {
  groupProcessBlocks,
  type ProcessBlock,
  type RoundProcess,
  type RoundProcessGroup,
  type RoundProcessTool,
} from "./transcript-process";

type OpenFileHandler = (filePath: string, fileName: string, line?: number) => void;

function FilePathButton({
  reference,
  cwd,
  onOpenFile,
  children,
}: {
  reference: FileReference;
  cwd?: string | null;
  onOpenFile?: OpenFileHandler;
  children: React.ReactNode;
}) {
  const resolved = resolveFileReferencePath(reference, cwd);
  if (!resolved || !onOpenFile) return <code className="rounded bg-[#EDF3FD] px-1 py-0.5 font-mono text-[0.92em] text-ink">{children}</code>;
  const line = reference.line;
  return (
    <button
      type="button"
      onClick={() => onOpenFile(resolved, getFileName(resolved), line)}
      title={`打开 ${resolved}${line ? `:${line}` : ""}`}
      className="inline cursor-pointer rounded bg-[#EDF3FD] px-1 py-0.5 font-mono text-[0.92em] text-accent-strong underline decoration-accent/30 underline-offset-2 transition-colors hover:bg-[#E8EFFB] hover:decoration-accent"
    >
      {children}
    </button>
  );
}

function FileLinkText({
  text,
  cwd,
  onOpenFile,
}: {
  text: string;
  cwd?: string | null;
  onOpenFile?: OpenFileHandler;
}) {
  if (!onOpenFile) return <>{text}</>;
  const segments = findFileReferences(text);
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "file" && segment.reference ? (
          <FilePathButton
            key={index}
            reference={segment.reference}
            cwd={cwd}
            onOpenFile={onOpenFile}
          >
            {segment.value}
          </FilePathButton>
        ) : (
          <span key={index}>{segment.value}</span>
        ),
      )}
    </>
  );
}

function LinkifiedChildren({
  children,
  cwd,
  onOpenFile,
}: {
  children: React.ReactNode;
  cwd?: string | null;
  onOpenFile?: OpenFileHandler;
}) {
  return (
    <>
      {Children.map(children, (child) =>
        typeof child === "string" ? (
          <FileLinkText text={child} cwd={cwd} onOpenFile={onOpenFile} />
        ) : (
          child
        ),
      )}
    </>
  );
}

const MARKDOWN_PLUGINS = { remarkPlugins: [remarkGfm, remarkMath], rehypePlugins: [rehypeKatex] };

type InsertCodeHandler = (code: string, language?: string) => void;

function CodeBlock({
  code,
  lang,
  onInsertCode,
  onApply,
  applyTargetName,
}: {
  code: string;
  lang: string;
  onInsertCode?: InsertCodeHandler;
  onApply?: (code: string, language?: string) => void;
  applyTargetName?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  if (lang === "mermaid") return <MermaidBlock code={code} />;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-[#E3E8F2] bg-[#F5F8FD]">
      <div className="flex items-center justify-between border-b border-[#E3E8F2] px-3 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          {lang || "text"}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={copied ? "已复制代码" : "复制代码"}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-[#E8EFFB] hover:text-accent-strong"
          >
            {copied ? <Check size={11} strokeWidth={2.4} /> : <Copy size={11} strokeWidth={1.9} />}
            {copied ? "已复制" : "复制"}
          </button>
          {onApply && (
            <button
              type="button"
              onClick={() => onApply(code, lang || undefined)}
              aria-label={applyTargetName ? `将代码应用到 ${applyTargetName}` : "应用代码"}
              title={applyTargetName ? `将代码应用到 ${applyTargetName}` : "应用代码到右侧打开的文件"}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-[#E8EFFB] hover:text-accent-strong"
            >
              <CornerDownLeft size={11} strokeWidth={1.9} />
              应用
            </button>
          )}
        </span>
      </div>
      <pre className="overflow-x-auto p-3 text-[12.5px] leading-6">
        <code className="font-mono">{code}</code>
      </pre>
      {onInsertCode && (
        <div className="flex justify-end border-t border-[#E3E8F2] px-2 py-1">
          <button
            type="button"
            onClick={() => onInsertCode(code, lang)}
            className="rounded px-1.5 py-0.5 text-[10px] text-ink-faint transition-colors hover:bg-[#E8EFFB] hover:text-accent-strong"
          >
            插入到输入框
          </button>
        </div>
      )}
    </div>
  );
}

function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const rawId = useId();

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
        const id = `mermaid-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}-${Date.now()}`;
        return mermaid.render(id, code);
      })
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, rawId]);

  if (failed) return <CodeBlock code={code} lang="" />;
  if (!svg) {
    return <p className="mb-3 rounded-lg border border-[#E3E8F2] bg-[#F5F8FD] px-3 py-2 text-[11px] text-ink-faint">正在渲染图表…</p>;
  }
  return (
    <div
      className="mb-3 overflow-x-auto rounded-lg border border-[#E3E8F2] bg-white p-3 [&_svg]:mx-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function createMarkdownComponents(
  cwd?: string | null,
  onOpenFile?: OpenFileHandler,
  onInsertCode?: InsertCodeHandler,
  onApplyCode?: (code: string, language?: string) => void,
  applyTargetName?: string | null,
): Components {
  const linkify = (children: React.ReactNode) => (
    <LinkifiedChildren cwd={cwd} onOpenFile={onOpenFile}>{children}</LinkifiedChildren>
  );
  return {
  p: ({ children }) => <p className="mb-3 last:mb-0">{linkify(children)}</p>,
  h1: ({ children }) => <h1 className="mb-3 mt-5 text-[17px] font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2.5 mt-5 text-[15.5px] font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-4 text-[14.5px] font-semibold first:mt-0">{children}</h3>,
  ul: ({ children }) => <ul className="mb-3 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="mb-1">{linkify(children)}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-[#DCE6F8] pl-3 text-ink-muted">
      {linkify(children)}
    </blockquote>
  ),
  a: ({ href, children }) => {
    const target = resolveHrefFileReference(href, cwd);
    if (target && onOpenFile) {
      return (
        <button
          type="button"
          onClick={() => onOpenFile(target.path, getFileName(target.path), target.line)}
          title={`打开 ${target.path}${target.line ? `:${target.line}` : ""}`}
          className="inline cursor-pointer font-mono text-accent-strong underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          {children}
        </button>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-accent-strong underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      >
        {children}
      </a>
    );
  },
  pre: ({ children }) => <>{children}</>,
  img: ({ src, alt }) => {
    const url = typeof src === "string" ? src : undefined;
    if (!url) return null;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={alt ?? ""}
        loading="lazy"
        className="my-2 max-h-80 rounded-lg border border-[#E3E8F2] bg-white object-contain"
      />
    );
  },
  code: ({ className, children }) => {
    const lang = /language-([\w-]+)/.exec(className ?? "")?.[1]?.toLowerCase() ?? "";
    if (lang || String(children).includes("\n")) {
      return (
        <CodeBlock
          code={String(children).replace(/\n$/, "")}
          lang={lang}
          onInsertCode={onInsertCode}
          onApply={onApplyCode}
          applyTargetName={applyTargetName}
        />
      );
    }
    const raw = String(children);
    const reference = parseFileReference(raw);
    if (reference && onOpenFile) {
      return (
        <FilePathButton reference={reference} cwd={cwd} onOpenFile={onOpenFile}>
          {children}
        </FilePathButton>
      );
    }
    return (
      <code className="rounded bg-[#EDF3FD] px-1 py-0.5 font-mono text-[0.9em] text-ink">{children}</code>
    );
  },
  hr: () => <hr className="my-5 border-[#E3E8F2]" />,
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-[#E3E8F2] px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-[#E3E8F2] px-2 py-1">{linkify(children)}</td>,
  };
}

function userText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return stripImageDimensionNotes(content);
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
  // 图片缩放说明是给模型看的机器注记，不要混在用户原话里重复一遍。
  return stripImageDimensionNotes(text);
}

type TurnBlock =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "image"; src: string }
  | {
      kind: "tool";
      name: string;
      input: Record<string, unknown>;
      toolCallId?: string;
      result?: ToolResultMessage;
    };

/** Resolve pi/UI image blocks (`{source:{base64|url}}` or `{data,mimeType}`). */
function imageSrc(block: Record<string, unknown>): string | null {
  const source = block.source as Record<string, unknown> | undefined;
  if (source && typeof source === "object") {
    if (source.type === "url" && typeof source.url === "string") return source.url;
    if (typeof source.data === "string") {
      return `data:${typeof source.media_type === "string" ? source.media_type : "image/png"};base64,${source.data}`;
    }
  }
  if (typeof block.data === "string") {
    return `data:${typeof block.mimeType === "string" ? block.mimeType : "image/png"};base64,${block.data}`;
  }
  return null;
}

function contentImages(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "image")
    .map((block) => imageSrc(block))
    .filter((src): src is string => Boolean(src));
}

/**
 * 对话里的图片：点开看大图（缩放/平移/旋转/下载/复制）。
 * 用一个薄壳包住 `<img>`，本地状态只在点开时有开销。
 */
function ClickableImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const images = useMemo(() => [{ data: "", mimeType: "", previewUrl: src }], [src]);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block cursor-zoom-in border-0 bg-transparent p-0"
        title={alt}
        aria-label={alt}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} loading="lazy" decoding="async" className={className} />
      </button>
      {open && <ImageLightbox images={images} index={0} onClose={() => setOpen(false)} />}
    </>
  );
}

interface DecisionAnswerView {
  kind: string;
  choice?: string;
  score?: number;
  probability?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface DecisionDetailsView {
  kind: "decision";
  ok: boolean;
  mode: string;
  provider?: string;
  model?: string;
  answers: Record<string, DecisionAnswerView>;
  elapsedMs?: number;
  error?: string;
}

interface ImageDetailsView {
  kind: "image-generation";
  ok: boolean;
  provider?: string;
  model?: string;
  prompt?: string;
  count?: number;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readDecisionDetails(details: unknown): DecisionDetailsView | null {
  const record = asRecord(details);
  if (!record || record.kind !== "decision") return null;
  const answers = asRecord(record.answers) ?? {};
  return {
    kind: "decision",
    ok: record.ok !== false,
    mode: typeof record.mode === "string" ? record.mode : "choice",
    ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    answers: answers as Record<string, DecisionAnswerView>,
    ...(typeof record.elapsedMs === "number" ? { elapsedMs: record.elapsedMs } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

function readImageDetails(details: unknown): ImageDetailsView | null {
  const record = asRecord(details);
  if (!record || record.kind !== "image-generation") return null;
  return {
    kind: "image-generation",
    ok: record.ok !== false,
    ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
    ...(typeof record.count === "number" ? { count: record.count } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

function percent(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = value > 1 ? value : value * 100;
  return `${Math.round(normalized)}%`;
}

interface PersistedOutputView {
  toolCallId: string;
  file: string;
  bytes: number;
  lines: number;
  previewLines: number;
  omittedLines: number;
}

function readPersistedOutput(details: unknown): PersistedOutputView | null {
  const record = asRecord(details);
  const marker = record ? asRecord(record.toolOutput) : null;
  if (!marker || marker.kind !== "tool-output" || typeof marker.file !== "string") return null;
  return {
    toolCallId: typeof marker.toolCallId === "string" ? marker.toolCallId : "",
    file: marker.file,
    bytes: typeof marker.bytes === "number" ? marker.bytes : 0,
    lines: typeof marker.lines === "number" ? marker.lines : 0,
    previewLines: typeof marker.previewLines === "number" ? marker.previewLines : 0,
    omittedLines: typeof marker.omittedLines === "number" ? marker.omittedLines : 0,
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TOOL_OUTPUT_PAGE_SIZE = 200;

interface ToolOutputPageView {
  text: string;
  offset: number;
  limit: number;
  totalLines: number;
  hasMore: boolean;
}

/** "查看完整输出" footer with in-card pagination over the persisted log. */
function PersistedOutputPanel({ output }: { output: PersistedOutputView }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ToolOutputPageView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/tool-outputs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: output.file, offset, limit: TOOL_OUTPUT_PAGE_SIZE }),
        });
        const data = (await res.json()) as ToolOutputPageView & { error?: string };
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        setPage(data);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [output.file],
  );

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !page) void load(0);
  };

  const lineCount = page?.text ? page.text.split("\n").length : 0;

  return (
    <div className="border-t border-[#EDF1F7] bg-[#FBFCFE] px-3 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded bg-[#FFF3E0] px-1.5 py-0.5 text-[10px] font-medium text-[#9A5B13]">
          已截断
        </span>
        <span className="text-ink-muted">
          完整输出已保存 · {output.lines} 行 / {formatBytes(output.bytes)}
        </span>
        <span className="hidden font-mono text-[10px] text-ink-faint sm:inline">tool_history_get</span>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="ml-auto shrink-0 rounded-md border border-border bg-white px-2 py-1 text-[11px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
        >
          {open ? "收起完整输出" : "查看完整输出"}
        </button>
      </div>
      {open && (
        <div className="mt-1.5 overflow-hidden rounded-md border border-[#E3E8F2] bg-white">
          {loading && !page ? (
            <p className="px-2 py-2 text-[11px] text-ink-faint">加载中…</p>
          ) : error ? (
            <p className="px-2 py-2 text-[11px] text-[#B0443C]">{error}</p>
          ) : page ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-[#EDF1F7] px-2 py-1 text-[10.5px] text-ink-faint">
                <span className="tabular-nums">
                  第 {page.offset + 1}–{page.offset + lineCount} 行 / 共 {page.totalLines} 行
                </span>
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void load(Math.max(0, page.offset - TOOL_OUTPUT_PAGE_SIZE))}
                    disabled={loading || page.offset <= 0}
                    className="rounded border border-border px-1.5 py-0.5 text-[10.5px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-40"
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    onClick={() => void load(page.offset + TOOL_OUTPUT_PAGE_SIZE)}
                    disabled={loading || !page.hasMore}
                    className="rounded border border-border px-1.5 py-0.5 text-[10.5px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-40"
                  >
                    下一页
                  </button>
                </span>
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-[10.5px] leading-4 text-ink-soft">
                {page.text || "（空）"}
              </pre>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface SubagentDetailsView {
  kind: "subagent";
  ok: boolean;
  name?: string;
  status?: string;
  durationMs?: number;
  toolCalls?: number;
  verified?: boolean;
  verificationReason?: string;
  error?: string;
}

function readSubagentDetails(details: unknown): SubagentDetailsView | null {
  const record = asRecord(details);
  if (!record || record.kind !== "subagent") return null;
  return {
    kind: "subagent",
    ok: record.ok !== false,
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
    ...(typeof record.toolCalls === "number" ? { toolCalls: record.toolCalls } : {}),
    ...(typeof record.verified === "boolean" ? { verified: record.verified } : {}),
    ...(typeof record.verificationReason === "string" ? { verificationReason: record.verificationReason } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

const SUBAGENT_STATUS_LABEL: Record<string, string> = {
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** Compact badges for `classify_decision` results (choice / score / bool). */
function DecisionBadges({ details }: { details: DecisionDetailsView }) {
  const entries = Object.entries(details.answers);
  const modelLabel = [details.provider, details.model].filter(Boolean).join("/");
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-[#EDF1F7] bg-[#F7FAFF] px-3 py-1.5">
      <span className="rounded bg-[#EDF3FD] px-1.5 py-0.5 text-[10px] font-medium text-accent-strong">
        决策
      </span>
      {!details.ok && (
        <span className="rounded-full border border-[#F5D3D3] bg-white px-2 py-0.5 text-[11px] text-[#B0443C]">
          {details.error ?? "决策失败"}
        </span>
      )}
      {entries.map(([key, answer]) => {
        const confidence = percent(answer.confidence);
        if (answer.kind === "choice") {
          return (
            <span
              key={key}
              className="inline-flex items-center gap-1 rounded-full border border-[#D9E5FB] bg-white px-2 py-0.5 text-[11px] text-ink"
              title={answer.probabilities ? JSON.stringify(answer.probabilities) : undefined}
            >
              <span className="font-medium">{answer.choice ?? "—"}</span>
              {confidence && <span className="text-ink-faint">{confidence}</span>}
            </span>
          );
        }
        if (answer.kind === "score") {
          return (
            <span
              key={key}
              className="inline-flex items-center gap-1 rounded-full border border-[#D9E5FB] bg-white px-2 py-0.5 text-[11px] text-ink"
            >
              <span>
                评分 <span className="font-medium">{answer.score ?? "—"}</span>
              </span>
              {confidence && <span className="text-ink-faint">{confidence}</span>}
            </span>
          );
        }
        const probability = percent(answer.probability);
        return (
          <span
            key={key}
            className="inline-flex items-center gap-1 rounded-full border border-[#D9E5FB] bg-white px-2 py-0.5 text-[11px] text-ink"
          >
            概率 <span className="font-medium">{probability ?? "—"}</span>
          </span>
        );
      })}
      {modelLabel && (
        <span className="ml-auto truncate font-mono text-[10px] text-ink-faint">{modelLabel}</span>
      )}
    </div>
  );
}

const SUMMARY_KEYS = [
  "command",
  "cmd",
  "path",
  "file_path",
  "filePath",
  "pattern",
  "query",
  "url",
  "name",
  "prompt",
];

function toolSummary(input: Record<string, unknown>): string {
  const direct = SUMMARY_KEYS.map((key) => input[key]).find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const fallback = Object.values(input).find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const raw = (direct ?? fallback ?? "").replace(/\s+/g, " ").trim();
  return raw.length > 110 ? `${raw.slice(0, 107)}…` : raw;
}

function toolResultsById(messages: AgentMessage[]): Map<string, ToolResultMessage> {
  const map = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolCallId) {
      map.set(message.toolCallId, message);
    }
  }
  return map;
}

function assistantBlocks(
  message: AgentMessage,
  results: Map<string, ToolResultMessage>,
): TurnBlock[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  const blocks: TurnBlock[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      blocks.push({ kind: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      blocks.push({ kind: "thinking", text: block.thinking });
    } else if (block.type === "image") {
      const src = imageSrc(block);
      if (src) blocks.push({ kind: "image", src });
    } else if (block.type === "toolCall") {
      const name = (block.toolName ?? block.name) as string | undefined;
      if (!name) continue;
      const input = (block.input ?? block.arguments ?? {}) as Record<string, unknown>;
      const id = (block.toolCallId ?? block.id) as string | undefined;
      blocks.push({
        kind: "tool",
        name,
        input: input && typeof input === "object" ? input : {},
        toolCallId: id,
        result: id ? results.get(id) : undefined,
      });
    }
  }
  return blocks;
}

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function resultText(result: ToolResultMessage): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

type NestedCall = NonNullable<ToolResultMessage["nestedCalls"]>["calls"][number];

export interface NestedExecutionView {
  status: "running" | "ok" | "error";
  durationMs?: number;
  output?: string;
}

/** Group nested records by their `parent/n` id prefix so the tree mirrors execution. */
function buildNestedTree(calls: NestedCall[]): Map<string | null, NestedCall[]> {
  const ids = new Set(calls.map((call) => call.id));
  const tree = new Map<string | null, NestedCall[]>();
  for (const call of calls) {
    const slash = call.id.lastIndexOf("/");
    const parentId = slash > 0 ? call.id.slice(0, slash) : null;
    const parent = parentId && ids.has(parentId) ? parentId : null;
    const bucket = tree.get(parent);
    if (bucket) bucket.push(call);
    else tree.set(parent, [call]);
  }
  return tree;
}

function NestedToolRow({
  call,
  depth,
  tree,
  executions,
}: {
  call: NestedCall;
  depth: number;
  tree: Map<string | null, NestedCall[]>;
  executions?: Record<string, NestedExecutionView>;
}) {
  const children = tree.get(call.id) ?? [];
  const live = executions?.[call.id];
  const status = live?.status ?? call.status;
  const duration = formatDuration(live?.durationMs ?? call.durationMs);
  const output = live?.output?.trim() ?? "";
  const args = call.arguments ? toolSummary(call.arguments) : call.argumentsBytes ? `${call.argumentsBytes} bytes` : "";
  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-0.5 text-[11px]"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <span className="shrink-0 font-mono text-ink-faint">{depth === 0 ? "└" : "·"}</span>
        <span className="shrink-0 font-mono text-ink-muted">{call.name}</span>
        {args && <span className="min-w-0 flex-1 truncate font-mono text-ink-faint">{args}</span>}
        {status === "error" ? (
          <X size={10} strokeWidth={2.5} className="shrink-0 text-[#C2554E]" aria-label="失败" />
        ) : status === "unfinished" || status === "running" ? (
          <span className="shrink-0 text-[10px] text-ink-faint">
            {status === "running" ? "运行中" : "未完成"}
          </span>
        ) : (
          <Check size={10} strokeWidth={2.5} className="shrink-0 text-[#3E8A63]" aria-label="完成" />
        )}
        {duration && <span className="shrink-0 tabular-nums text-ink-faint">{duration}</span>}
      </div>
      {call.error && (
        <p
          className="whitespace-pre-wrap break-all py-0.5 text-[10.5px] text-[#B0443C]"
          style={{ paddingLeft: 20 + depth * 12 }}
        >
          {call.error}
        </p>
      )}
      {output && (
        <details
          className="py-0.5 text-[10.5px] text-ink-faint"
          style={{ paddingLeft: 20 + depth * 12 }}
        >
          <summary className="cursor-pointer select-none hover:text-ink-muted">
            结果（{output.split("\n").length} 行）
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-[#F5F8FD] px-2 py-1 font-mono text-[10px] leading-4 text-ink-soft">
            {output}
          </pre>
        </details>
      )}
      {children.map((child) => (
        <NestedToolRow
          key={child.id}
          call={child}
          depth={depth + 1}
          tree={tree}
          executions={executions}
        />
      ))}
    </div>
  );
}

/**
 * 折叠面板的「用户意图记忆」。
 * 流式更新会让文章节点的归属发生变化（同一轮里的过程块会从第 N 条消息挪到
 * 第 N+1 条消息），React 会重建子树 → 局部 state 归零，用户刚点开的卡片又
 * 被默认值收回去。这里用一份模块级 map 记住"用户最后一次点的是开还是关"，
 * 重挂载后优先恢复它；只保留最近 500 条，避免无限增长。
 */
const stickyOpenState = new Map<string, boolean>();

function readStickyOpen(key: string | undefined): boolean | undefined {
  return key ? stickyOpenState.get(key) : undefined;
}

function writeStickyOpen(key: string | undefined, value: boolean): void {
  if (!key) return;
  if (stickyOpenState.size > 500) stickyOpenState.clear();
  stickyOpenState.set(key, value);
}

/**
 * 一轮对话的过程数据（分组类型与折叠逻辑在 `transcript-process.ts`，便于直接跑测试）。
 * `groups` **保持时间顺序**：思考与工具按真实交错顺序分组，不再拆成两个平行数组。
 */
export type {
  RoundProcess,
  RoundProcessGroup,
  RoundProcessThinking,
  RoundProcessTool,
} from "./transcript-process";

/** 消息时间（ms）→ 内容左下角的小标签：当天只给 `HH:MM`，跨天补上 `M/D`。 */
function timeLabel(timestamp: number | undefined): string | null {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

/** Token 数量：超过 1 万就缩写（zh: 123.4万 / en: 1.2M），避免一长串数字吓人。 */
function formatTokenCount(value: number, locale: string): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 10_000) return value.toLocaleString();
  try {
    return new Intl.NumberFormat(locale.startsWith("zh") ? "zh-CN" : "en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return `${Math.round(value / 1000)}k`;
  }
}

/**
 * 金额格式化：消耗常常小到 1e-6 级别，固定 4 位小数会全变成 0.0000。
 * - < 0.0001：显示 `<¥0.0001`（避免假零）
 * - < 0.01  ：6 位小数并去掉尾部 0
 * - < 1     ：4 位小数
 * - 其它    ：2 位小数
 */
function formatMoney(cost: number, currencySymbol: string): string | null {
  if (!Number.isFinite(cost) || cost <= 0) return null;
  if (cost < 0.0001) return `<${currencySymbol}0.0001`;
  if (cost < 0.01) {
    const text = cost.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    return `${currencySymbol}${text}`;
  }
  if (cost < 1) return `${currencySymbol}${cost.toFixed(4)}`;
  return `${currencySymbol}${cost.toFixed(2)}`;
}

/**
 * 金额小数位：按“3 位有效数字”取（夹在 2–6 位），小数越小位数越多且不丢有效位。
 * 例：0.001034 → 6 位（¥0.001034）；0.021 → 5 位（¥0.02070）；0.5 → 4 位；1.234 → 2 位。
 */
function moneyDecimals(cost: number): number {
  if (!Number.isFinite(cost) || cost <= 0) return 2;
  const digits = 3 - Math.floor(Math.log10(cost));
  return Math.min(6, Math.max(2, digits));
}

/** 固定小数位的金额（不进行 `<0.0001` 降级，保证两行位数一致）；没有计价数据时返回 null。 */
function formatMoneyFixed(cost: number, currencySymbol: string, digits: number): string | null {
  if (!Number.isFinite(cost) || cost <= 0) return null;
  return `${currencySymbol}${cost.toFixed(digits)}`;
}

/** 单个思考段 / 工具卡的估算消耗（tokens + 折算价格）。 */
export interface BlockUsage {
  tokens: number;
  cost: number;
}

function ToolCallCard({
  name,
  input,
  result,
  details,
  nestedExecutions,
  defaultExpanded = false,
  open: controlledOpen,
  onToggleOpen,
  streaming = false,
  toolCallId,
  tokensPerSecond,
  usage,
  currencySymbol = "$",
  liveOutput,
  stateKey,
  onUserInteract,
}: {
  name: string;
  input: Record<string, unknown>;
  /** 本次调用 id：看门狗只把「卡住」标到真正卡住的那一行。 */
  toolCallId?: string;
  result?: ToolResultMessage;
  details?: unknown;
  nestedExecutions?: Record<string, NestedExecutionView>;
  /** 过程框展开时，工具卡直接摊开原始输入/输出，不用再逐个点。 */
  defaultExpanded?: boolean;
  /** 手风琴：父级传入时完全受控，同一时刻只展开一张卡。 */
  open?: boolean;
  /** 受控模式下切换展开。 */
  onToggleOpen?: () => void;
  /** 该工具仍在执行：右上角显示实时速度，输出区自动跟随到底。 */
  streaming?: boolean;
  tokensPerSecond?: number | null;
  /** 本卡片估算消耗，显示在右下角。 */
  usage?: BlockUsage | null;
  currencySymbol?: string;
  /** 执行中的实时输出（pi 的 tool_execution_update），没有时显示"正在执行…"。 */
  liveOutput?: string;
  /** 跨重挂载保存用户的手动展开/收起。 */
  stateKey?: string;
  /** 告知父级：用户动过这张卡，自动折叠逻辑要让路。 */
  onUserInteract?: () => void;
}) {
  // 手风琴：父级传入 open / onToggleOpen 时完全受控，同一时刻只展开一张卡。
  const isControlled = typeof controlledOpen === "boolean";
  const [internalOpen, setInternalOpen] = useState(() => readStickyOpen(stateKey) ?? defaultExpanded);
  const open = isControlled ? controlledOpen : internalOpen;
  /** 用户是否亲手点过（点过之后所有自动折叠逻辑一律让路）。 */
  const userToggledRef = useRef(isControlled ? false : readStickyOpen(stateKey) !== undefined);
  const setOpen = useCallback((next: boolean) => {
    if (next === open) return;
    if (isControlled) {
      onToggleOpen?.();
      return;
    }
    writeStickyOpen(stateKey, next);
    setInternalOpen(next);
  }, [open, isControlled, onToggleOpen, stateKey]);
  const toggle = () => {
    userToggledRef.current = true;
    setOpen(!open);
    onUserInteract?.();
  };

  /**
   * 执行结束（success / error）后不立刻收：先让用户看到最后一屏日志，
   * 1 秒后再折叠成「工具 · bash · npm run dev · 523ms」这一行摘要。
   * 只在"结果刚刚出现"那一次调度；用户手动展开过就不再自动收。
   */
  const hadResultRef = useRef(Boolean(result));
  useEffect(() => {
    const hasResult = Boolean(result);
    const justFinished = hasResult && !hadResultRef.current;
    hadResultRef.current = hasResult;
    if (!justFinished || userToggledRef.current || !open) return;
    const timer = window.setTimeout(() => {
      if (userToggledRef.current) return;
      setOpen(false);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [result, open, setOpen]);
  const rawSummary = toolSummary(input);
  /** 执行中：参数摘要和日志用打字机逐字刷出（结束后立刻补齐）。 */
  const typingLog = streaming && !result;
  const summary = useTypedText(rawSummary, typingLog, 10);
  const typedLiveOutput = useTypedText(liveOutput ?? "", typingLog, 24);
  const hasArgs = Object.keys(input).length > 0;
  const hasDetails = hasArgs || Boolean(result);
  const duration = formatDuration(result?.durationMs);
  /** 运行中的秒表：每 200ms 刷新，给人「真的在跑」的反馈。 */
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number>(0);
  useEffect(() => {
    if (!streaming) return;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 200);
    return () => window.clearInterval(timer);
  }, [streaming]);
  /**
   * 看门狗只读视图：主界面**只**保留「整行微红 + 图标提示」——
   * 详细诊断与介入动作全部收拢到右侧「系统监控」面板。
   * 数据来自只读快照，不触发任何请求/模型调用；未配置 Provider 时恒为 null。
   */
  const watchdogSessionId = useWatchdogSessionId();
  const stall = useToolStall(watchdogSessionId, Boolean(streaming));
  /**
   * 只有「这一行自己」被 Host 判定超阈值无输出时才算卡住：
   * 看门狗状态是会话级的，早先结束（甚至没参与）的工具不该被一起染红。
   */
  const stalledRow =
    stall?.level === "stalled" &&
    Boolean(streaming) &&
    (toolCallId
      ? stall.stuckToolCallIds.includes(toolCallId)
      : stall.pendingTool === name);
  const nested = result?.nestedCalls;
  const tree = nested?.calls.length ? buildNestedTree(nested.calls) : null;
  const output = result ? resultText(result).trim() : "";
  const resultImages = result ? contentImages(result.content) : [];
  const decision = useMemo(() => readDecisionDetails(details), [details]);
  const generatedImage = useMemo(() => readImageDetails(details), [details]);
  const persistedOutput = useMemo(() => readPersistedOutput(details), [details]);
  const subagent = useMemo(() => readSubagentDetails(details), [details]);
  const spawnPending = name === "spawn_agent" && !result;
  const spawnName = typeof input.name === "string" && input.name.trim() ? input.name.trim() : "agent";
  // Successful edit/write calls show what changed, right in the card: users
  // should not have to open the Git panel to see the AI's own edit.
  const codeDiff = useMemo(
    () => (result && !result.isError && isEditToolName(name) ? toolDiffRows(name, input) : null),
    [result, name, input],
  );
  const codeDiffStats = useMemo(() => (codeDiff ? diffStats(codeDiff) : null), [codeDiff]);
  const codeDiffPath = toolDiffPath(name, input);
  // 执行中让输出区一直贴底，形成"日志在流"的观感
  const outputRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = outputRef.current;
    if (el && streaming) el.scrollTop = el.scrollHeight;
  }, [streaming, output, liveOutput]);

  return (
    <div
      className={`overflow-hidden ${
        stalledRow
          ? "rounded-md border border-[#E9B8B4] bg-[#FDF2F2]"
          : streaming
            ? "tool-running rounded-md border border-accent/35 bg-white"
            : ""
      }`}
    >
      <button
        type="button"
        onClick={() => hasDetails && toggle()}
        aria-expanded={hasDetails ? open : undefined}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
          hasDetails ? "cursor-pointer transition-colors hover:bg-[#F7FAFF]" : "cursor-default"
        }`}
      >
        {streaming && (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#22c55e]"
          />
        )}
        <span className="shrink-0 rounded bg-[#EDF3FD] px-1.5 py-0.5 text-[10px] font-medium text-accent-strong">
          工具
        </span>
        {generatedImage && (
          <span className="shrink-0 rounded bg-[#F1ECFE] px-1.5 py-0.5 text-[10px] font-medium text-[#6D56C1]">
            生图
          </span>
        )}
        {name === "spawn_agent" && (
          <span className="shrink-0 rounded bg-[#E8F3FF] px-1.5 py-0.5 text-[10px] font-medium text-accent-strong">
            子 Agent
          </span>
        )}
        {decision && (
          <span className="shrink-0 rounded bg-[#EAF7F0] px-1.5 py-0.5 text-[10px] font-medium text-[#2F7A55]">
            决策
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px] text-ink-muted">· {name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-soft">
          {summary || (streaming ? "" : "（无参数）")}
          {streaming && !result && (
            <span className="ml-0.5 animate-pulse text-accent" aria-hidden="true">
              ▍
            </span>
          )}
        </span>
        {tree && (
          <span className="shrink-0 text-[10px] text-ink-faint">{nested?.calls.length} 子调用</span>
        )}
        {streaming ? (
          <span
            className={`shrink-0 tabular-nums text-[10.5px] ${
              stalledRow ? "text-[#B0443C]" : "text-accent-strong"
            }`}
          >
            {formatDuration(elapsedMs) ?? "0 ms"}
          </span>
        ) : (
          duration && (
            <span className="shrink-0 tabular-nums text-[10.5px] text-ink-faint">{duration}</span>
          )
        )}
        {stalledRow && (
          <TriangleAlert
            size={12}
            strokeWidth={2.4}
            className="shrink-0 text-[#C2554E]"
            aria-label="已标记无进展"
          />
        )}
        {result ? (
          result.isError ? (
            <X size={12} strokeWidth={2.5} className="shrink-0 text-[#C2554E]" aria-label="失败" />
          ) : (
            <Check size={12} strokeWidth={2.5} className="shrink-0 text-[#3E8A63]" aria-label="完成" />
          )
        ) : null}
        {hasDetails && (
          <ChevronDown
            size={12}
            strokeWidth={2}
            aria-hidden="true"
            className={`shrink-0 text-ink-faint transition-transform duration-150 ${
              open ? "rotate-180" : ""
            }`}
          />
        )}
        {streaming && tokensPerSecond ? (
          <span className="shrink-0 rounded bg-[#F1F3F7] px-1 py-px font-mono text-[10px] tabular-nums text-ink-faint">
            {tokensPerSecond} tokens/s
          </span>
        ) : null}
        {usage && usage.tokens > 0 && (
          <span className="shrink-0 text-[10px] tabular-nums text-gray-400">
            {usage.tokens.toLocaleString()} tokens
            {(() => {
              const money = formatMoney(usage.cost, currencySymbol);
              return money ? ` · ${money}` : "";
            })()}
          </span>
        )}
      </button>
      {name === "spawn_agent" && (
        <div className="border-t border-[#EDF1F7] bg-[#F7FBFF] px-3 py-1.5 text-[11px]">
          {spawnPending ? (
            <span className="flex items-center gap-1.5 text-accent-strong">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
              已启动子 Agent：{spawnName}，正在后台执行…
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-1.5 text-ink-muted">
              <span className="truncate">
                子 Agent：{subagent?.name ?? spawnName}
              </span>
              <span
                className={`rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium ${
                  subagent?.status === "failed"
                    ? "border-[#F0D5D2] bg-[#FDF6F5] text-[#B0443C]"
                    : subagent?.status === "cancelled"
                      ? "border-[#E3E8F2] bg-white text-ink-faint"
                      : "border-[#D9E5FB] bg-white text-accent-strong"
                }`}
              >
                {SUBAGENT_STATUS_LABEL[subagent?.status ?? ""] ?? (subagent?.ok === false ? "失败" : "已完成")}
              </span>
              {subagent?.status === "completed" && subagent.verified === false && (
                <span
                  title={subagent.verificationReason}
                  className="rounded-full border border-[#F0E0C2] bg-[#FFF9EE] px-1.5 py-0.5 text-[9.5px] font-medium text-[#9A6B1F]"
                >
                  未验证
                </span>
              )}
              {subagent?.durationMs !== undefined && (
                <span className="tabular-nums text-ink-faint">{formatDuration(subagent.durationMs)}</span>
              )}
              {subagent?.toolCalls !== undefined && (
                <span className="text-ink-faint">{subagent.toolCalls} 次工具调用</span>
              )}
              {subagent?.error && <span className="truncate text-[#B0443C]">{subagent.error}</span>}
              <button
                type="button"
                onClick={() => window.dispatchEvent(new Event("piforge:agents-open"))}
                className="ml-auto shrink-0 rounded border border-border bg-white px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
              >
                查看 Agents
              </button>
            </span>
          )}
        </div>
      )}
      {generatedImage && (generatedImage.ok || generatedImage.error) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-[#EDF1F7] bg-[#FBF9FF] px-3 py-1.5 text-[11px] text-ink-muted">
          <span className="truncate">
            {generatedImage.ok
              ? `已生成 ${generatedImage.count ?? resultImages.length} 张图片`
              : `生成失败：${generatedImage.error ?? "未知错误"}`}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
            {[generatedImage.provider, generatedImage.model].filter(Boolean).join("/")}
          </span>
        </div>
      )}
      {/* Generated images stay visible without expanding the card. */}
      {resultImages.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-[#EDF1F7] bg-white p-2">
          {resultImages.map((src, index) => (
            <ClickableImage
              key={index}
              src={src}
              alt={`工具输出图片 ${index + 1}`}
              className="max-h-72 rounded-md border border-[#E3E8F2] object-contain"
            />
          ))}
        </div>
      )}
      {decision && <DecisionBadges details={decision} />}
      {persistedOutput && <PersistedOutputPanel output={persistedOutput} />}
      {open && hasDetails && (
        <div className="border-t border-[#EDF1F7] bg-[#FBFCFE]">
          {tree && (
            <div className="border-b border-[#EDF1F7] px-1 py-1.5">
              <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                执行树
              </p>
              {(tree.get(null) ?? []).map((call) => (
                <NestedToolRow
                  key={call.id}
                  call={call}
                  depth={0}
                  tree={tree}
                  executions={nestedExecutions}
                />
              ))}
              {nested && !nested.complete && (
                <p className="px-2 pt-1 text-[10px] text-ink-faint">
                  部分子调用未记录（超出数量或体积上限）
                </p>
              )}
            </div>
          )}
          {codeDiff && codeDiff.length > 0 && codeDiffStats && (
            <div className="border-b border-[#EDF1F7]">
              <p className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                <span>代码改动</span>
                {codeDiffPath && (
                  <span className="min-w-0 truncate font-mono text-[10.5px] normal-case tracking-normal text-ink-muted">
                    {getFileName(codeDiffPath)}
                  </span>
                )}
                {codeDiffStats.added > 0 && (
                  <span className="font-mono text-[10px] normal-case tracking-normal text-[#16A34A]">
                    +{codeDiffStats.added}
                  </span>
                )}
                {codeDiffStats.removed > 0 && (
                  <span className="font-mono text-[10px] normal-case tracking-normal text-[#DC2626]">
                    −{codeDiffStats.removed}
                  </span>
                )}
              </p>
              <div className="diff-flash max-h-72 overflow-auto border-t border-[#EDF1F7] bg-white">
                <DiffRows rows={codeDiff} />
              </div>
            </div>
          )}
          {decision && Object.keys(decision.answers).length > 0 && (
            <details className="border-b border-[#EDF1F7] last:border-b-0">
              <summary className="cursor-pointer select-none px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                决策结果（JSON）
              </summary>
              <pre className="max-h-64 overflow-auto px-3 pb-2 font-mono text-[11.5px] leading-5 text-ink-soft">
                {JSON.stringify(decision.answers, null, 2)}
              </pre>
            </details>
          )}
          {hasArgs && (
            <details className="border-b border-[#EDF1F7] last:border-b-0" open={!tree && !output}>
              <summary className="cursor-pointer select-none px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                原始输入
              </summary>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all px-3 pb-2 font-mono text-[11.5px] leading-5 text-ink-soft">
                {JSON.stringify(input, null, 2)}
              </pre>
            </details>
          )}
          {result && (
            <details className="border-[#EDF1F7] last:border-b-0" open={!tree && !hasArgs}>
              <summary className="cursor-pointer select-none px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                原始输出{result.isError ? "（失败）" : ""}
              </summary>
              <pre
                ref={outputRef}
                className="max-h-64 overflow-auto whitespace-pre-wrap break-all px-3 pb-2 font-mono text-[11.5px] leading-5 text-ink-soft"
              >
                {output ||
                  (streaming
                    ? typedLiveOutput && typedLiveOutput.trim()
                      ? typedLiveOutput
                      : "正在执行…"
                    : "（空）")}
                {streaming && <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-accent align-middle" aria-hidden="true" />}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/** 折叠/展开共用的高度过渡：0fr ↔ 1fr，内容常驻但收起后不占空间。 */
function Collapsible({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-150 ease-out ${
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
      }`}
      style={{ willChange: "grid-template-rows" }}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** 把一个块的文本按 message 级 usage 的比例折算成 tokens / 价格。 */
function blockUsage(text: string, messageUsage?: AssistantMessage["usage"]): BlockUsage | null {
  const tokens = estimateTokens(text);
  if (tokens <= 0) return null;
  const totalTokens =
    (messageUsage?.input ?? 0) +
    (messageUsage?.output ?? 0) +
    (messageUsage?.cacheRead ?? 0) +
    (messageUsage?.cacheWrite ?? 0);
  const totalCost = messageUsage?.cost?.total ?? 0;
  const cost = totalTokens > 0 && totalCost > 0 ? (tokens / totalTokens) * totalCost : 0;
  return { tokens, cost };
}

/**
 * 思考链：
 *  - 思考中（live）默认展开，边流边看，正文只渲染尾部并在内部容器里自动跟底；
 *  - 思考结束（开始输出最终文字）自动收起成一行摘要；
 *  - 用户手动点过的，自动展开/收起一律让路。
 */
const THINKING_LIVE_TAIL = 2400;

function ThinkingSection({
  items,
  live,
  tokensPerSecond,
  currencySymbol,
  stateKey,
  onBranch,
  onFork,
  forkingEntryId,
}: {
  items: Array<{
    text: string;
    usage?: AssistantMessage["usage"];
    entryId?: string;
    timestamp?: number;
  }>;
  live: boolean;
  tokensPerSecond?: number;
  currencySymbol: string;
  stateKey?: string;
  onBranch?: (entryId: string) => void | Promise<void>;
  onFork?: (entryId: string) => void;
  forkingEntryId?: string | null;
}) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const copyItem = (text: string, index: number) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        /* 剪贴板不可用时静默 */
      }
    })();
    setCopiedIndex(index);
    window.setTimeout(() => setCopiedIndex((cur) => (cur === index ? null : cur)), 1200);
  };
  // 思考中默认展开，结束后默认收起；用户手动点过就记住（跨重挂载恢复）
  const [open, setOpen] = useState(() => readStickyOpen(stateKey) ?? live);
  const userToggledRef = useRef(readStickyOpen(stateKey) !== undefined);
  const toggle = () => {
    userToggledRef.current = true;
    const next = !open;
    writeStickyOpen(stateKey, next);
    setOpen(next);
  };
  useEffect(() => {
    if (userToggledRef.current) return;
    setOpen(live);
  }, [live]);
  // 边想边看：容器内自动跟底（不滚动整页）；用户往上翻过就不再抢滚。
  const bodyRef = useRef<HTMLDivElement>(null);
  const textLength = items.reduce((total, item) => total + item.text.length, 0);
  useEffect(() => {
    if (!live || !open) return;
    const el = bodyRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance > 80) return;
    el.scrollTop = el.scrollHeight;
  }, [live, open, textLength]);
  const speed = live && tokensPerSecond && tokensPerSecond > 0 ? tokensPerSecond : null;
  /** 「思考」一栏的合计消耗（折叠行右侧安静地显示一次）。 */
  const totalUsage = items.reduce(
    (acc, item) => {
      const usage = blockUsage(item.text, item.usage);
      if (usage) {
        acc.tokens += usage.tokens;
        acc.cost += usage.cost;
      }
      return acc;
    },
    { tokens: 0, cost: 0 },
  );
  const totalMoney = formatMoney(totalUsage.cost, currencySymbol);

  return (
    <div className="mt-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-0 text-left text-[11px] text-ink-faint transition-colors hover:text-ink-muted"
      >
        {live ? (
          <Loader2 size={12} strokeWidth={1.9} aria-hidden="true" className="shrink-0 animate-spin" />
        ) : (
          <BrainCircuit size={12} strokeWidth={1.9} aria-hidden="true" className="shrink-0" />
        )}
        <span className={live ? "animate-pulse" : undefined}>
          {live ? "思考中…" : "思考过程"} · {items.length} 段{open ? "" : "（点击展开）"}
        </span>
        {speed !== null && (
          <span className="shrink-0 rounded bg-[#F1F3F7] px-1 py-px font-mono text-[10px] tabular-nums text-ink-faint">
            {speed} tokens/s
          </span>
        )}
        {totalUsage.tokens > 0 && (
          <span className="shrink-0 text-[10px] tabular-nums text-gray-400">
            {totalUsage.tokens.toLocaleString()} tokens
            {totalMoney ? ` · ${totalMoney}` : ""}
          </span>
        )}
        <ChevronDown
          size={11}
          strokeWidth={2}
          aria-hidden="true"
          className={`ml-auto shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <Collapsible open={open}>
        <div
          ref={bodyRef}
          className="mt-1 max-h-[240px] space-y-1.5 overflow-y-auto border-l-2 border-[#EDEBE4] pl-3"
        >
          {items.map((item, index) => {
            const usage = blockUsage(item.text, item.usage);
            const money = usage ? formatMoney(usage.cost, currencySymbol) : null;
            const entryId = item.entryId;
            const itemTime = timeLabel(item.timestamp);
            // 流式中只渲染尾部：长思考逐帧挂全文会把滚动和输入框拖卡
            const tailOnly = live && item.text.length > THINKING_LIVE_TAIL;
            const shownText = tailOnly ? item.text.slice(-THINKING_LIVE_TAIL) : item.text;
            return (
              <div key={`thinking-${index}`} className="group/think">
                {tailOnly && (
                  <div className="mb-0.5 text-[10px] text-ink-faint">
                    …已省略前 {item.text.length - THINKING_LIVE_TAIL} 字（结束后可展开全文）
                  </div>
                )}
                <div className="whitespace-pre-wrap break-words text-[12px] leading-6 text-ink-faint">
                  {shownText}
                </div>
                <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px]">
                  {itemTime && (
                    <span className="mr-auto tabular-nums text-ink-faint">{itemTime}</span>
                  )}
                  {usage && (
                    <span className="tabular-nums text-ink-faint">
                      {usage.tokens.toLocaleString()} tokens{money ? ` · ${money}` : ""}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => copyItem(item.text, index)}
                    title={copiedIndex === index ? "已复制" : "复制这段思考"}
                    className="flex items-center gap-1 rounded-md px-1 py-0.5 text-ink-faint opacity-0 transition-colors hover:bg-[#ECECEF] hover:text-ink focus:opacity-100 group-hover/think:opacity-100"
                  >
                    {copiedIndex === index ? (
                      <Check size={10} strokeWidth={2.2} className="text-[#3E8A63]" aria-hidden="true" />
                    ) : (
                      <Copy size={10} strokeWidth={1.9} aria-hidden="true" />
                    )}
                    {copiedIndex === index ? "已复制" : "复制"}
                  </button>
                  {entryId && onBranch && (
                    <button
                      type="button"
                      onClick={() => void onBranch(entryId)}
                      title="从此消息开启新分支"
                      className="flex items-center gap-1 rounded-md px-1 py-0.5 text-ink-faint opacity-0 transition-colors hover:bg-[#ECECEF] hover:text-accent-strong focus:opacity-100 group-hover/think:opacity-100"
                    >
                      <GitBranch size={10} strokeWidth={1.9} aria-hidden="true" />
                      分支
                    </button>
                  )}
                  {entryId && onFork && (
                    <button
                      type="button"
                      onClick={() => onFork(entryId)}
                      disabled={forkingEntryId === entryId}
                      title={forkingEntryId === entryId ? "正在创建会话…" : "从此处派生新会话"}
                      className={`flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors disabled:cursor-not-allowed ${
                        forkingEntryId === entryId
                          ? "text-accent opacity-100"
                          : "text-ink-faint opacity-0 hover:bg-[#ECECEF] hover:text-accent-strong focus:opacity-100 group-hover/think:opacity-100"
                      }`}
                    >
                      <GitFork size={10} strokeWidth={1.9} aria-hidden="true" />
                      {forkingEntryId === entryId ? "创建中…" : "派生"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Collapsible>
    </div>
  );
}

/**
 * 工具卡片栈：手风琴（同一时刻只展开一张）+ 执行中的那张自动展开。
 * 两处复用：没有前置思考的「工具」一栏，以及挂在某段思考下方的工具调用。
 */
function ToolCardStack({
  items,
  nestedExecutions,
  running,
  tokensPerSecond,
  currencySymbol,
  liveOutputs,
  liveOutputFor,
  stateKey,
  onUserInteract,
}: {
  items: RoundProcessTool[];
  nestedExecutions?: Record<string, NestedExecutionView>;
  running: boolean;
  tokensPerSecond?: number;
  currencySymbol: string;
  liveOutputs?: Record<string, string>;
  liveOutputFor?: (toolName: string) => string | undefined;
  stateKey?: string;
  onUserInteract?: () => void;
}) {
  /**
   * 并行调用时自动展开的是**最新**那个（数组末尾的未完成项），不是第一个：
   * 并行派发下第一个往往早就跑完了，一直盯着它反而看不到正在跑的那个。
   */
  const lastPendingIndex = (list: typeof items): number => {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (!list[index].block.result) return index;
    }
    return -1;
  };
  const [openIndex, setOpenIndex] = useState<number | null>(() => {
    if (!running) return null;
    const idx = lastPendingIndex(items);
    return idx >= 0 ? idx : null;
  });
  const runningIndex = lastPendingIndex(items);
  useEffect(() => {
    if (running && runningIndex >= 0) setOpenIndex(runningIndex);
  }, [running, runningIndex]);

  return (
    <>
      {items.map((item, index) => (
        <ToolCallCard
          key={`${item.block.name}-${index}`}
          name={item.block.name}
          input={item.block.input}
          result={item.block.result}
          details={item.block.result?.details}
          nestedExecutions={nestedExecutions}
          open={openIndex === index}
          onToggleOpen={() => setOpenIndex((prev) => (prev === index ? null : index))}
          streaming={running && !item.block.result}
          toolCallId={item.block.toolCallId}
          tokensPerSecond={tokensPerSecond}
          usage={blockUsage(
            `${item.block.name} ${JSON.stringify(item.block.input)} ${
              item.block.result ? resultText(item.block.result) : ""
            }`,
            item.usage,
          )}
          currencySymbol={currencySymbol}
          liveOutput={liveOutputFor ? liveOutputFor(item.block.name) : liveOutputs?.[item.block.name]}
          stateKey={stateKey ? `${stateKey}:tool:${index}` : undefined}
          onUserInteract={onUserInteract}
        />
      ))}
    </>
  );
}

/**
 * 「工具」一栏：执行期间默认展开（逐个卡片摊开 + 日志跟随 + 速度徽标），
 * 一旦开始输出最终文字就整栏自动收起，只留一行 `已执行 N 个操作 (bash x2)`。
 * 只用于**没有前置思考**的工具调用；挂在思考下的走 ToolCardStack。
 */
function ToolsSection({
  items,
  nestedExecutions,
  live,
  finalStarted,
  tokensPerSecond,
  currencySymbol,
  liveOutputs,
  liveOutputFor,
  stateKey,
}: {
  items: Array<{ block: Extract<TurnBlock, { kind: "tool" }>; usage?: AssistantMessage["usage"] }>;
  nestedExecutions?: Record<string, NestedExecutionView>;
  live: boolean;
  /** 已经开始输出最终 Markdown 文字 → 立刻自动收起。 */
  finalStarted: boolean;
  tokensPerSecond?: number;
  currencySymbol: string;
  liveOutputs?: Record<string, string>;
  /** 稳定取值器（父级 ref + useCallback([])）：逐帧读实时输出不会让 memo 失效。 */
  liveOutputFor?: (toolName: string) => string | undefined;
  stateKey?: string;
}) {
  const running = live && !finalStarted;
  // 执行中优先"强制展开"，只有非执行态才回落到用户上次的 sticky 选择
  const [open, setOpen] = useState(() => (live && !finalStarted ? true : readStickyOpen(stateKey) ?? false));
  /** 用户手动点过就锁住，自动折叠不再覆盖。 */
  const userToggledRef = useRef(readStickyOpen(stateKey) !== undefined);
  const toggle = () => {
    const next = !open;
    userToggledRef.current = true;
    writeStickyOpen(stateKey, next);
    setOpen(next);
  };

  /** 上一帧是否在跑：用于识别"新一次执行开始"（初始值不用 running，避免初始化顺序问题）。 */
  const wasRunningRef = useRef(false);
  useEffect(() => {
    // 新一次执行开始（false → true）：清掉上一轮的手动记忆，强制展开，
    // 这样开发时一定能看到"正在执行 + 日志滚动"的过程态。
    if (running && !wasRunningRef.current) {
      userToggledRef.current = false;
      setOpen(true);
    }
    wasRunningRef.current = running;
  }, [running]);

  useEffect(() => {
    // 执行中展开；开始写最终回复时立刻收起（用户手动干预过则不覆盖）
    if (userToggledRef.current) return;
    setOpen(live && !finalStarted);
  }, [live, finalStarted]);

  const counts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.block.name] = (acc[item.block.name] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} x${count}`)
    .join(", ");
  const failed = items.filter((item) => item.block.result?.isError).length;
  const speed = live && tokensPerSecond && tokensPerSecond > 0 ? tokensPerSecond : null;
  /** 整个「工具」一栏的合计消耗（只在摘要行右侧安静地显示一次）。 */
  const totalUsage = items.reduce(
    (acc, item) => {
      const usage = blockUsage(
        `${item.block.name} ${JSON.stringify(item.block.input)} ${
          item.block.result ? resultText(item.block.result) : ""
        }`,
        item.usage,
      );
      if (usage) {
        acc.tokens += usage.tokens;
        acc.cost += usage.cost;
      }
      return acc;
    },
    { tokens: 0, cost: 0 },
  );
  const totalMoney = formatMoney(totalUsage.cost, currencySymbol);

  return (
    <div className="mt-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-0 text-left text-[11px] text-ink-faint transition-colors hover:text-ink-muted"
      >
        {running ? (
          <Loader2 size={12} strokeWidth={1.9} aria-hidden="true" className="shrink-0 animate-spin" />
        ) : (
          <Wrench
            size={12}
            strokeWidth={1.9}
            aria-hidden="true"
            className={`shrink-0 ${failed > 0 ? "text-[#C2554E]" : "text-ink-faint"}`}
          />
        )}
        <span className={`min-w-0 truncate ${running ? "animate-pulse" : ""}`}>
          {running ? `正在执行 ${items.length} 个操作` : `已执行 ${items.length} 个操作`}
          {running && (
            <span className="ml-0.5 animate-pulse text-accent" aria-hidden="true">
              ▍
            </span>
          )}
          {summary && <span className="ml-1 font-mono text-[10.5px]">({summary})</span>}
          {failed > 0 && <span className="ml-1 text-[#C2554E]">{failed} 个失败</span>}
          {!open && "（点击展开）"}
        </span>
        {speed !== null && (
          <span className="shrink-0 rounded bg-[#F1F3F7] px-1 py-px font-mono text-[10px] tabular-nums text-ink-faint">
            {speed} tokens/s
          </span>
        )}
        {totalUsage.tokens > 0 && (
          <span className="shrink-0 text-[10px] tabular-nums text-gray-400">
            {totalUsage.tokens.toLocaleString()} tokens
            {totalMoney ? ` · ${totalMoney}` : ""}
          </span>
        )}
        <ChevronDown
          size={11}
          strokeWidth={2}
          aria-hidden="true"
          className={`ml-auto shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <Collapsible open={open}>
        <div className="mt-1 divide-y divide-[#F3F5F9] border-l-2 border-[#EDEBE4] pl-2">
          <ToolCardStack
            items={items}
            nestedExecutions={nestedExecutions}
            running={running}
            tokensPerSecond={tokensPerSecond}
            currencySymbol={currencySymbol}
            liveOutputs={liveOutputs}
            liveOutputFor={liveOutputFor}
            stateKey={stateKey}
            onUserInteract={() => {
              userToggledRef.current = true;
            }}
          />
        </div>
      </Collapsible>
    </div>
  );
}

/**
 * 一组过程：一段思考 + 紧跟其后的工具调用（无思考时只剩工具）。
 * 思考与工具不再各占据一个折叠框，而是按真实因果排在一起：
 * 展开哪段思考，它的工具就在它下面。
 */
function ProcessGroupRow({
  group,
  live,
  finalStarted,
  tokensPerSecond,
  currencySymbol,
  nestedExecutions,
  liveOutputs,
  liveOutputFor,
  stateKey,
  onBranch,
  onFork,
  forkingEntryId,
}: {
  group: RoundProcessGroup;
  live: boolean;
  finalStarted: boolean;
  tokensPerSecond?: number;
  currencySymbol: string;
  nestedExecutions?: Record<string, NestedExecutionView>;
  liveOutputs?: Record<string, string>;
  liveOutputFor?: (toolName: string) => string | undefined;
  stateKey?: string;
  onBranch?: (entryId: string) => void | Promise<void>;
  onFork?: (entryId: string) => void;
  forkingEntryId?: string | null;
}) {
  const running = live && !finalStarted;

  // 没有前置思考：保持原来的「工具」一栏（一行摘要 `已执行 N 个操作 (bash x2)`）。
  if (!group.thinking) {
    return (
      <ToolsSection
        items={group.tools}
        nestedExecutions={nestedExecutions}
        live={live}
        finalStarted={finalStarted}
        tokensPerSecond={tokensPerSecond}
        currencySymbol={currencySymbol}
        liveOutputs={liveOutputs}
        liveOutputFor={liveOutputFor}
        stateKey={stateKey ? `${stateKey}:tools` : undefined}
      />
    );
  }

  const toolStack =
    group.tools.length > 0 ? (
      <div className="mt-0.5 divide-y divide-[#F3F5F9] border-l-2 border-[#EDEBE4] pl-3">
        <ToolCardStack
          items={group.tools}
          nestedExecutions={nestedExecutions}
          running={running}
          tokensPerSecond={tokensPerSecond}
          currencySymbol={currencySymbol}
          liveOutputs={liveOutputs}
          liveOutputFor={liveOutputFor}
          stateKey={stateKey ? `${stateKey}:tools` : undefined}
        />
      </div>
    ) : null;

  return (
    <>
      <ThinkingSection
        items={[group.thinking]}
        live={live && !finalStarted}
        tokensPerSecond={tokensPerSecond}
        currencySymbol={currencySymbol}
        stateKey={stateKey ? `${stateKey}:think` : undefined}
        onBranch={onBranch}
        onFork={onFork}
        forkingEntryId={forkingEntryId}
      />
      {toolStack}
    </>
  );
}

/**
 * 一轮回复的渲染：
 *  - 思考 → 「思考链」一栏（默认收起）
 *  - 工具 → 「工具」一栏（执行中展开，开始输出最终文字即自动收起）
 *  - 最终 Markdown → 独立、干净地展示在最下方，右下角给出总消耗
 */
function AssistantBlocks({
  blocks,
  nestedExecutions,
  turn,
  markdownComponents,
  live = false,
  tokensPerSecond,
  messageUsage,
  currencySymbol,
  laterTurnStarted = false,
  roundProcess,
  showProcess = true,
  liveToolOutputs,
  liveOutputFor,
  roundKey,
  onBranch,
  onFork,
  forkingEntryId,
}: {
  blocks: TurnBlock[];
  nestedExecutions?: Record<string, NestedExecutionView>;
  turn: { text: string; messageIndex: number };
  markdownComponents: Components;
  live?: boolean;
  tokensPerSecond?: number;
  messageUsage?: AssistantMessage["usage"];
  currencySymbol: string;
  /**
   * 后面已经有新的轮次（= 模型开始写最终回复 / 又发起新一轮）。
   * 工具调用常常在**上一条 assistant 消息**里，最终文字在**下一条消息**里，
   * 只看本条 blocks 永远等不到"最终文字"，所以必须把这个信号传进来。
   */
  laterTurnStarted?: boolean;
  /** 按「一轮对话」聚合好的思考 + 工具（跨多条 assistant 消息合并）。 */
  roundProcess?: RoundProcess;
  /** 只有本轮最后一条 assistant 消息负责渲染过程块，避免出现多个工具标题。 */
  showProcess?: boolean;
  /** 执行中工具的实时输出（toolName → 文本）。 */
  liveToolOutputs?: Record<string, string>;
  /** 稳定取值器：按工具名读实时输出（引用恒定，不打断 memo）。 */
  liveOutputFor?: (toolName: string) => string | undefined;
  /** 本轮唯一标识：用于记忆折叠面板的用户选择。 */
  roundKey?: number;
  /** 思考段的 复制 / 分支 / 派生 回调。 */
  onBranch?: (entryId: string) => void | Promise<void>;
  onFork?: (entryId: string) => void;
  forkingEntryId?: string | null;
}) {
  if (blocks.length === 0) {
    return (
      <>
        <ReactMarkdown {...MARKDOWN_PLUGINS} components={markdownComponents}>
          {turn.text}
        </ReactMarkdown>
      </>
    );
  }

  // 「最终结果」= 出现过工具/思考之后的那段文字（通常是最后一段）
  let finalTextIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].kind === "text") {
      finalTextIndex = index;
      break;
    }
  }
  if (finalTextIndex >= 0) {
    const hasProcessBefore = blocks
      .slice(0, finalTextIndex)
      .some((block) => block.kind === "tool" || block.kind === "thinking");
    if (!hasProcessBefore) finalTextIndex = -1;
  }

  const groups: RoundProcessGroup[] = roundProcess
    ? roundProcess.groups
    : groupProcessBlocks(
        blocks.flatMap((block): ProcessBlock[] => {
          if (block.kind === "thinking") {
            return [{ kind: "thinking", thinking: { text: block.text, usage: messageUsage } }];
          }
          if (block.kind === "tool") return [{ kind: "tool", tool: { block, usage: messageUsage } }];
          return [];
        }),
      );
  const hasProcess = groups.length > 0;

  // 纯文字/图片（没有思考也没有工具）：不套折叠框，直接渲染
  if (!hasProcess) {
    return (
      <>
        {blocks.map((block, index) =>
          block.kind === "image" ? (
            <ClickableImage
              key={`plain-img-${index}`}
              src={block.src}
              alt="模型输出图片"
              className="my-2 max-h-80 rounded-lg border border-[#E3E8F2] object-contain"
            />
          ) : block.kind === "text" ? (
            <ReactMarkdown
              key={`plain-text-${index}`}
              {...MARKDOWN_PLUGINS}
              components={markdownComponents}
            >
              {block.text}
            </ReactMarkdown>
          ) : null,
        )}
      </>
    );
  }

  /**
   * 「开始输出最终回复」的判定（两种都算）：
   * 1. 本条消息里，最后一个文本块之后不再有工具/思考 → 它自己就是最终回复；
   * 2. 后面已经出现了新的轮次 → 本条的思考/工具已经结束（最常见的真实形态）。
   */
  const textTailHasProcess =
    finalTextIndex >= 0 &&
    blocks
      .slice(finalTextIndex + 1)
      .some((block) => block.kind === "tool" || block.kind === "thinking");
  const finalStarted = (finalTextIndex >= 0 && !textTailHasProcess) || laterTurnStarted;
  const interimText = blocks.filter(
    (block, index) => block.kind === "text" && index !== finalTextIndex,
  );

  return (
    <>
      {showProcess &&
        groups.map((group, index) => (
          <ProcessGroupRow
            key={`process-${index}`}
            group={group}
            live={live}
            finalStarted={finalStarted}
            tokensPerSecond={tokensPerSecond}
            currencySymbol={currencySymbol}
            nestedExecutions={nestedExecutions}
            liveOutputs={liveToolOutputs}
            liveOutputFor={liveOutputFor}
            stateKey={roundKey !== undefined ? `round:${roundKey}:item:${index}` : undefined}
            onBranch={onBranch}
            onFork={onFork}
            forkingEntryId={forkingEntryId}
          />
        ))}

      {interimText.map((block, index) =>
        block.kind === "text" ? (
          <ReactMarkdown
            key={`interim-${index}`}
            {...MARKDOWN_PLUGINS}
            components={markdownComponents}
          >
            {block.text}
          </ReactMarkdown>
        ) : null,
      )}

      {finalTextIndex >= 0 && blocks[finalTextIndex].kind === "text" && (
        <div className="mt-2">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-faint">
            <span className="h-1 w-1 rounded-full bg-accent" aria-hidden="true" />
            最终回复
          </div>
          <div className="text-[14px] leading-7 text-ink">
            <ReactMarkdown {...MARKDOWN_PLUGINS} components={markdownComponents}>
              {(blocks[finalTextIndex] as Extract<TurnBlock, { kind: "text" }>).text}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* 惰性渲染：离屏轮次的复杂内容（Markdown / 代码高亮 / 工具卡）换成等高空壳 */
/* -------------------------------------------------------------------------- */

/** 进入这个距离就水合（px）。 */
const LAZY_HYDRATE_MARGIN_PX = 1200;
/**
 * 离开这个距离才卸载（px），**必须大于**水合距离。
 * 单档阈值等于一个没有滞回的开关：卡在边界上的那一轮会「水合 → 撑高越界 →
 * 卸载 → 缩回界内 → 再水合」来回抖，整页跟着上下跳。
 */
const LAZY_UNMOUNT_MARGIN_PX = 2000;
/** 重新进入安全区后，等滚动稍停再水合，避免拖拽期间逐帧渲染。 */
const LAZY_HYDRATE_DELAY_MS = 80;

/**
 * 包住一轮消息的**正文**（不含角色行/复制按钮）：
 * - 安全区内：正常渲染完整内容；
 * - 离开 1200px 缓冲：记住真实高度后替换成等高灰块；
 * - 重新靠近：滚动停 80ms 后再水合（拖拽期间不逐帧挂载）。
 * `pin`（正在流式输出的那一轮）永不卸载。
 */
function LazyTurnBody({ pin = false, children }: { pin?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const activeRef = useRef(true);
  const pinnedRef = useRef(pin);
  const heightRef = useRef(0);
  const [active, setActive] = useState(true);

  pinnedRef.current = pin;

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    let el: HTMLElement | null = node.parentElement;
    while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
    if (!el) return;

    let timer: number | null = null;
    const hydrate = () => {
      if (activeRef.current || timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        activeRef.current = true;
        setActive(true);
      }, LAZY_HYDRATE_DELAY_MS);
    };
    const unmount = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (!activeRef.current || pinnedRef.current) return;
      // 切到后台标签时容器是 display:none，这一帧高度为 0，IO 也会报
      // not-intersecting。此时若照常卸载，heightRef 会被记成 0，占位符
      // 塔成 min-h-16，整页高度骤降、切回后 scrollTop 被 clamp（表现为
      // “乱跳到中间”）。高度为 0 就当作“不可测量”，保留已渲染内容。
      const measured = node.getBoundingClientRect().height;
      if (measured <= 0) return;
      heightRef.current = measured;
      activeRef.current = false;
      setActive(false);
    };
    // 水合与卸载必须用两档距离（`rootMargin` 一次只能给一档）。
    const hydrateObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) hydrate();
      },
      { root: el, rootMargin: `${LAZY_HYDRATE_MARGIN_PX}px 0px` },
    );
    const unmountObserver = new IntersectionObserver(
      (entries) => {
        if (entries.every((entry) => !entry.isIntersecting)) unmount();
      },
      { root: el, rootMargin: `${LAZY_UNMOUNT_MARGIN_PX}px 0px` },
    );
    hydrateObserver.observe(node);
    unmountObserver.observe(node);
    return () => {
      hydrateObserver.disconnect();
      unmountObserver.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return (
    <div
      ref={ref}
      style={active ? undefined : { height: heightRef.current || undefined }}
      data-lazy={active ? undefined : "placeholder"}
    >
      {active ? children : <div aria-hidden="true" className="h-full min-h-16 w-full rounded-xl bg-[#F1F3F7]" />}
    </div>
  );
}

/** 单条回复的用量小结：灰线 = 本次输出的真实消耗；蓝线 = 本轮叠加。 */
function TurnUsage({
  usage,
  currencySymbol = "$",
  tokens: tokensOverride,
  cost: costOverride,
  breakdown,
  label = "本次新增",
  tone = "muted",
  /** 与同一块里另一行对齐的小数位（不传则按月金额大小自适应）。 */
  decimals,
  locale = "zh-CN",
}: {
  usage?: AssistantMessage["usage"];
  currencySymbol?: string;
  /** 传入聚合后的值（整轮总计）时优先使用。 */
  tokens?: number;
  cost?: number;
  /** 输入 / 缓存 / 输出的明细（整轮聚合值）。 */
  breakdown?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  label?: string;
  /** muted = 灰色（单条真实消耗）；round = 蓝色（本轮叠加）。 */
  tone?: "muted" | "round";
  /** 固定小数位：让灰色行与蓝色行的小数位数完全对齐。 */
  decimals?: number;
  locale?: string;
}) {
  const parts = breakdown ?? {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
  };
  /** 主行只显示"新增"：input + output，不含缓存读写。 */
  const added = parts.input + parts.output;
  /** 悬浮里给出全量口径（含缓存 / 历史上下文）。 */
  const total = tokensOverride ?? added + parts.cacheRead + parts.cacheWrite;
  if (added <= 0 && total <= 0) return null;
  const cost = costOverride ?? usage?.cost?.total ?? 0;
  const money = decimals === undefined ? formatMoney(cost, currencySymbol) : formatMoneyFixed(cost, currencySymbol, decimals);
  const cache = parts.cacheRead + parts.cacheWrite;
  const scope = tone === "round" ? "本轮全部模型调用（含思考与工具轮次）" : "这一条回复";
  const detail = [
    `新增 ${fmt(added)}（输入 ${fmt(parts.input)} + 输出 ${fmt(parts.output)}）`,
    `全量 ${fmt(total)}（缓存命中 ${fmt(cache)}）`,
    `口径：新增 = 本轮新送入 + 新生成；全量 = 含历史上下文与缓存命中；统计范围 = ${scope}`,
  ].join(" · ");
  return (
    <p
      className={`text-right text-[11px] tabular-nums ${tone === "round" ? "mt-0.5 text-[#2563EB]" : "mt-1.5 text-gray-400"}`}
      title={detail}
    >
      {label}: {formatTokenCount(added, locale)} tokens
      {money ? ` · ${money}` : ""}
    </p>
  );

  function fmt(value: number): string {
    return formatTokenCount(value, locale);
  }
}

/**
 * 两行用量：灰色 = 本次输出真实消耗（自己的真实小数位），蓝色 = 本轮叠加（与之对齐）。
 * 纯渲染计算（一次 log10 + 两次 toFixed），不产生任何模型调用。
 */
function TurnUsagePair({
  usage,
  totals,
  currencySymbol,
  locale,
}: {
  usage?: AssistantMessage["usage"];
  totals?: RoundTotals;
  currencySymbol: string;
  locale: string;
}) {
  const thisCost = usage?.cost?.total ?? 0;
  // 两行共用位数，但只增不减：谁需要更多位就取谁，本轮的钱永远不会被四舍五入变粗。
  const digits = Math.max(moneyDecimals(thisCost), moneyDecimals(totals?.cost ?? 0));
  return (
    <>
      <TurnUsage usage={usage} currencySymbol={currencySymbol} decimals={digits} locale={locale} />
      {totals && (
        <TurnUsage
          usage={usage}
          currencySymbol={currencySymbol}
          tokens={totals.tokens}
          cost={totals.cost}
          breakdown={{
            input: totals.input,
            output: totals.output,
            cacheRead: totals.cacheRead,
            cacheWrite: totals.cacheWrite,
          }}
          label="本轮对话新增"
          tone="round"
          decimals={digits}
          locale={locale}
        />
      )}
    </>
  );
}

/** 首屏只挂载最近这么多轮；更早的历史按需展开（长会话切换不再卡顿）。 */
const INITIAL_TURNS = 20;
const TURN_BATCH = 20;

/** 稳定的空引用：缺省的实时工具输出用它，避免每帧 new 一个 `{}`。 */
const EMPTY_TOOL_OUTPUTS: Record<string, string> = {};

/** 引用级比较：同一轮的 turn 对象一个都没换（历史已冻结）就算没变。 */
function sameTurnRefs(a: TranscriptTurnView[], b: TranscriptTurnView[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

export interface TranscriptTurnView {
  role: "user" | "assistant";
  text: string;
  images: string[];
  blocks: TurnBlock[];
  messageIndex: number;
  /** 该条消息自己的时间戳（ms），左下角标签用；老数据可能没有。 */
  timestamp?: number;
  /**
   * 由「人工介入」注入的 user 消息（看门狗追问 / 强制跳过）。
   * 它在会话文件里就是一条 user 消息，但用户并没有亲手输入 ——
   * 渲染成灰卡片，并从回合导航里剔除，避免「你」说出自己没说过的话。
   */
  systemNote?: boolean;
}

/**
 * messages → 渲染轮次（Transcript 与右侧导航共用的唯一数据源）。
 *
 * 导航以前是扫 DOM 的 `[data-turn-role="user"]`，一旦「首屏只挂载最近 20 轮」
 * 生效，更早的轮次根本不在 DOM 里，刻度就只剩零星几个。这里把推导逻辑抽出来，
 * 导航直接遍历完整 messages，与当前挂载了多少 DOM 无关。
 */
/**
 * 轮次对象缓存：身份复用逻辑在 `lib/transcript-turn-cache.ts`（有单测覆盖），
 * 这里只负责把「消息 → 外部引用」和「消息 → 轮次视图」两件事交给它。
 */
const turnCacheStore = globalThis as typeof globalThis & {
  __piforgeTranscriptTurnCache?: WeakMap<AgentMessage, TurnCacheEntry<TranscriptTurnView>>;
};
function turnCache() {
  if (!turnCacheStore.__piforgeTranscriptTurnCache) {
    turnCacheStore.__piforgeTranscriptTurnCache = new WeakMap();
  }
  return turnCacheStore.__piforgeTranscriptTurnCache;
}

/** 一条 assistant 消息里所有 toolCall 的结果引用（用于判断该轮是否真的变了）。 */
function toolResultRefsOf(
  message: AgentMessage,
  results: Map<string, ToolResultMessage>,
): readonly unknown[] {
  if (message.role !== "assistant") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const refs: unknown[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "toolCall" && typeof block.id === "string") {
      refs.push(results.get(block.id));
    }
  }
  return refs;
}

export function buildTranscriptTurns(messages: AgentMessage[]): TranscriptTurnView[] {
  const results = toolResultsById(messages);
  return buildWithTurnCache<AgentMessage, TranscriptTurnView>(messages, turnCache(), {
    refsOf: (message) => toolResultRefsOf(message, results),
    build: (message, index) => buildTranscriptTurn(message, index, results),
  }).filter((turn): turn is TranscriptTurnView => turn !== null);
}

/** 单条消息 → 轮次视图（无缓存版本；供上面的缓存包装调用）。 */
function buildTranscriptTurn(
  message: AgentMessage,
  messageIndex: number,
  results: Map<string, ToolResultMessage>,
): TranscriptTurnView | null {
  if (message.role === "user") {
    const text = userText(message).trim();
    const images = contentImages((message as { content?: unknown }).content);
    const timestamp = (message as { timestamp?: number }).timestamp;
    const systemNote = isInterventionText(text);
    return text || images.length > 0
      ? { role: "user", text, images, blocks: [], messageIndex, timestamp, systemNote }
      : null;
  }
  if (message.role === "assistant") {
    const blocks = assistantBlocks(message, results);
    const timestamp = (message as { timestamp?: number }).timestamp;
    return blocks.length > 0
      ? { role: "assistant", text: "", images: [], blocks, messageIndex, timestamp }
      : null;
  }
  if (message.role === "custom") {
    // 扩展注入的隐藏上下文（display:false）属于请求侧：只给模型看，不进对话记录。
    // 例：PIFORGE_PREFIX_STRIP_CWD=1 时的 `<context>cwd: …</context>`。
    if (!(message as { display?: boolean }).display) return null;
    const text = userText(message).trim();
    return text ? { role: "assistant", text, images: [], blocks: [], messageIndex } : null;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 单条轮次（TurnRow）：React.memo + 自定 areEqual                              */
/* -------------------------------------------------------------------------- */

/**
 * 一轮对话的用量合计（输入 + 输出 + 缓存读 + 缓存写，跨本轮所有 assistant 消息）。
 * 父级按 `roundKey` 记忆化，历史轮的引用保持不变，末条才拿到它。
 */
interface RoundTotals {
  tokens: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 「复制这段内容」的目标文本：用户取原文，AI 取全部文本块。 */
function turnCopyText(turn: TranscriptTurnView): string {
  if (turn.role === "user") return turn.text;
  return turn.blocks
    .filter((block): block is Extract<TurnBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("\n\n");
}

/**
 * 单条轮次的 props：**全部显式传入**，组件内部不引用父组件闭包。
 * 只有这样 `areTurnRowPropsEqual` 才有意义 —— 流式期间父级每帧重建的
 * 只有最后那一条，其余行的 props 引用原封不动，memo 就能整行跳过。
 */
interface TurnRowProps {
  turn: TranscriptTurnView;
  /** 在 turns 里的下标：`#turn-N`、复制态、`round:N` 折叠记忆都用它。 */
  index: number;
  /** 本轮最后一条 assistant 消息（思考 / 工具过程块只在它身上渲染）。 */
  isLastOfRound: boolean;
  /** 所属轮次 key（= 本轮用户消息的 turns 下标）；-1 表示无归属。 */
  roundKey: number;
  /** 整轮聚合的思考 + 工具（父级按轮缓存，历史轮引用稳定）。 */
  roundProcess?: RoundProcess;
  /** 整轮用量合计：只给本轮末条，其余为 undefined。 */
  usageTotals?: RoundTotals;
  /** 当前挂载列表里的第一条（顶部不画分割线）。 */
  firstInList: boolean;
  markdownComponents: Components;
  currencySymbol: string;
  locale: string;
  /** 只有被复制的那一条是 true（父级传 `copiedTurn === index`）。 */
  copied: boolean;
  /** 本条消息的 usage（流式那条由父级从 streamingMessage 取）。 */
  usage?: AssistantMessage["usage"];
  /** 本条消息的会话条目 id（fork / 分支的锚点）。 */
  entryId?: string;
  /** 这一条正在流式输出（会话在跑 且 是最后一条）。 */
  live: boolean;
  /** 整个会话正在跑：用来判断「本条的思考 / 工具已经结束」。 */
  liveTurn: boolean;
  tokensPerSecond?: number;
  /** 执行中工具的实时输出（按工具名索引，只对正在跑的那条有意义）。 */
  liveToolOutputs?: Record<string, string>;
  /** 稳定取值器（父级 useCallback([]) + ref），逐帧调用不会破坏 memo。 */
  liveOutputFor: (toolName: string) => string | undefined;
  nestedExecutions?: Record<string, NestedExecutionView>;
  cwd?: string | null;
  onOpenFile?: OpenFileHandler;
  onCopy: (index: number, text: string) => void;
  onFork?: (entryId: string) => void;
  /** 正在为本条派生新会话。 */
  forking: boolean;
  /** 会话正在跑：分支/派生按钮禁用（宿主会拒绝）。 */
  busy?: boolean;
  onBranch?: (entryId: string) => void | Promise<void>;
  branchSwitch?: (entryId: string) => BranchSwitchInfo | null;
  onSwitchBranch?: (leafId: string | null) => void;
}

function TurnRowImpl({
  turn,
  index,
  isLastOfRound,
  roundKey,
  roundProcess,
  usageTotals,
  firstInList,
  markdownComponents,
  currencySymbol,
  locale,
  copied,
  usage,
  entryId,
  live,
  liveTurn,
  tokensPerSecond,
  liveToolOutputs,
  liveOutputFor,
  nestedExecutions,
  cwd,
  onOpenFile,
  onCopy,
  onFork,
  forking,
  busy,
  onBranch,
  branchSwitch,
  onSwitchBranch,
}: TurnRowProps) {
  /** 开发期渲染计数：直接量化「历史行有没有跟着流式重渲」。 */
  const renderCountRef = useRef(0);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    renderCountRef.current += 1;
    console.debug(`[render] turn ${index} rendered ${renderCountRef.current} times`);
  });

  // The very first message cannot be forked (nothing before it), and a
  // fork mid-stream would race the entry ids the SSE events don't carry.
  // 系统提示不是用户的提问：从它派生/开分支没有意义。
  const canFork = Boolean(onFork && entryId) && turn.messageIndex > 0 && !turn.systemNote;
  const canBranch = Boolean(onBranch && entryId) && !turn.systemNote;
  const switcher = entryId && branchSwitch ? branchSwitch(entryId) : null;
  /** 后面已经有新的轮次 → 本条的思考 / 工具已经结束，过程块立刻收起。 */
  const laterTurnStarted = liveTurn && !live;
  /** 左下角的时间：提问与回答各用自己那条消息的时间。 */
  const time = timeLabel(turn.timestamp);

  return (
    <article
      id={`turn-${index}`}
      data-message-index={turn.messageIndex}
      data-turn-role={turn.role}
      // 渲染隔离：每条消息自成 layout/paint/style 容器，滚动时互不牵连；
      // 外部留白：AI 回复内部紧凑（mt-0.5 / mt-2），「用户提问」上方用
      // 细分割线 + 大间距划出一轮对话的边界。
      className={`group relative overflow-hidden scroll-mt-4 [contain:content] [overflow-anchor:none] ${
        turn.role === "user"
          ? turn.systemNote
            ? "mt-4 mb-1"
            : firstInList
              ? "mb-1"
              : "mt-8 mb-1 border-t border-gray-100 pt-6"
          : "mt-0.5 mb-3"
      }`}
    >
      <div
        className={`flex items-center justify-between gap-2 ${
          turn.role === "user" ? "mb-2" : "mb-0.5"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          {switcher && switcher.total > 1 && (
            <span
              className="flex shrink-0 items-center gap-0.5 rounded-full border border-[#E3E8F2] bg-white px-1 py-0.5 text-[10.5px] text-ink-muted shadow-[0_1px_2px_rgba(17,17,17,0.03)]"
              aria-label={`分支 ${switcher.index + 1}/${switcher.total}`}
            >
              <button
                type="button"
                onClick={() => onSwitchBranch?.(switcher.targets[switcher.index - 1]?.leafId ?? null)}
                disabled={switcher.index <= 0}
                aria-label="上一个分支"
                title="上一个分支"
                className="flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:cursor-default disabled:opacity-30"
              >
                <ChevronLeft size={11} strokeWidth={2.2} aria-hidden="true" />
              </button>
              <span className="tabular-nums px-0.5">
                {switcher.index + 1}/{switcher.total}
              </span>
              <button
                type="button"
                onClick={() => onSwitchBranch?.(switcher.targets[switcher.index + 1]?.leafId ?? null)}
                disabled={switcher.index >= switcher.total - 1}
                aria-label="下一个分支"
                title="下一个分支"
                className="flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:cursor-default disabled:opacity-30"
              >
                <ChevronRight size={11} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </span>
          )}
          <span
            className={`truncate text-[11px] font-medium uppercase tracking-[0.08em] ${
              turn.systemNote ? "text-ink-faint" : turn.role === "user" ? "text-accent" : "text-gray-700"
            }`}
          >
            {turn.systemNote ? "系统提示" : turn.role === "user" ? "你" : "PiForge"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onCopy(index, turnCopyText(turn))}
          title={copied ? "已复制" : "复制这段内容"}
          aria-label={copied ? "已复制" : "复制这段内容"}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-faint opacity-0 transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink focus:opacity-100 group-hover:opacity-100"
        >
          {copied ? (
            <Check size={11} strokeWidth={2.2} className="text-[#3E8A63]" aria-hidden="true" />
          ) : (
            <Copy size={11} strokeWidth={1.9} aria-hidden="true" />
          )}
          {copied ? "已复制" : "复制"}
        </button>
        {canBranch && (
          <button
            type="button"
            onClick={() => void onBranch!(entryId!)}
            disabled={busy}
            title={busy ? "本轮回复结束后才能切分支" : "从此消息开启新分支"}
            aria-label={busy ? "本轮回复结束后才能切分支" : "从此消息开启新分支"}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-faint opacity-0 transition-colors duration-150 hover:bg-[#ECECEF] hover:text-accent-strong focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-faint"
          >
            <GitBranch size={11} strokeWidth={1.9} aria-hidden="true" />
            分支
          </button>
        )}
        {canFork && (
          <button
            type="button"
            onClick={() => onFork!(entryId!)}
            disabled={forking || Boolean(busy)}
            title={forking ? "正在创建会话…" : busy ? "本轮回复结束后才能派生新会话" : "从此处派生新会话"}
            aria-label={forking ? "正在创建会话" : busy ? "本轮回复结束后才能派生新会话" : "从此处派生新会话"}
            className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors duration-150 disabled:cursor-not-allowed ${
              forking
                ? "text-accent opacity-100"
                : "text-ink-faint opacity-0 hover:bg-[#ECECEF] hover:text-accent-strong focus:opacity-100 group-hover:opacity-100"
            }`}
          >
            <GitFork size={11} strokeWidth={1.9} aria-hidden="true" />
            {forking ? "创建中…" : "派生"}
          </button>
        )}
        </div>
      </div>

      <LazyTurnBody pin={live}>
      {turn.role === "user" ? (
        <div
          className={
            turn.systemNote
              ? "whitespace-pre-wrap break-words rounded-lg border border-dashed border-[#E3E8F2] bg-[#F7F8FA] px-3.5 py-2.5 text-[12.5px] leading-6 text-ink-muted"
              : "whitespace-pre-wrap break-words rounded-xl border border-[#E7E9EE] border-l-2 border-l-accent/50 bg-blue-50/30 px-4 py-3 text-[14px] leading-7 text-ink"
          }
        >
          {turn.text && <FileLinkText text={turn.text} cwd={cwd} onOpenFile={onOpenFile} />}
          {turn.images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {turn.images.map((src, imageIndex) => (
                <ClickableImage
                  key={imageIndex}
                  src={src}
                  alt={`用户图片 ${imageIndex + 1}`}
                  className="max-h-64 rounded-md border border-[#E7E9EE] object-contain"
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="break-words text-[14px] leading-7 text-ink-soft">
          <AssistantBlocks
            blocks={turn.blocks}
            nestedExecutions={nestedExecutions}
            turn={turn}
            markdownComponents={markdownComponents}
            live={live}
            laterTurnStarted={laterTurnStarted}
            roundProcess={roundProcess}
            showProcess={isLastOfRound}
            liveToolOutputs={liveToolOutputs}
            liveOutputFor={liveOutputFor}
            roundKey={roundKey >= 0 ? roundKey : undefined}
            tokensPerSecond={tokensPerSecond}
            messageUsage={usage}
            currencySymbol={currencySymbol}
            onBranch={onBranch}
            onFork={onFork}
            forkingEntryId={forking ? entryId : null}
          />
        </div>
      )}
      </LazyTurnBody>
      {/* 用量两行：灰色 = 本次输出真实消耗；蓝色 = 本轮叠加（小数位对齐灰行）。 */}
      {turn.role !== "user" && (
        <TurnUsagePair usage={usage} totals={usageTotals} currencySymbol={currencySymbol} locale={locale} />
      )}
      {time && (
        <div className="mt-1 text-left text-[10.5px] tabular-nums text-ink-faint">{time}</div>
      )}
    </article>
  );
}

/**
 * 逐项自定义比较：默认的 shallow compare 会把 `markdownComponents`（对象）、
 * `turn`（对象）当引用比，也会在流式期间被 `liveToolOutputs` 这类逐帧变化的
 * 引用拉下水，所以这里显式写清楚「什么算变了」。
 */
function areTurnRowPropsEqual(prev: TurnRowProps, next: TurnRowProps): boolean {
  // 约定好的必备项
  if (prev.turn !== next.turn) return false;
  if (prev.index !== next.index) return false;
  if (prev.isLastOfRound !== next.isLastOfRound) return false;
  if (prev.roundKey !== next.roundKey) return false;
  if (prev.firstInList !== next.firstInList) return false;
  if (prev.markdownComponents !== next.markdownComponents) return false;
  if (prev.currencySymbol !== next.currencySymbol) return false;
  if (prev.copied !== next.copied) return false;
  if (prev.usage !== next.usage) return false;
  if (prev.entryId !== next.entryId) return false;
  if (prev.usageTotals !== next.usageTotals) return false;

  // 下面这些是父级 useCallback / useMemo 冻结的引用或原始值：
  // 引用不等 = 真的变了（切会话、开跑 / 收跑、嵌套执行推进、分支数据刷新）。
  if (prev.locale !== next.locale) return false;
  if (prev.live !== next.live) return false;
  if (prev.liveTurn !== next.liveTurn) return false;
  if (prev.forking !== next.forking) return false;
  if (prev.busy !== next.busy) return false;
  if (prev.nestedExecutions !== next.nestedExecutions) return false;
  if (prev.cwd !== next.cwd) return false;
  if (prev.onOpenFile !== next.onOpenFile) return false;
  if (prev.onCopy !== next.onCopy) return false;
  if (prev.onFork !== next.onFork) return false;
  if (prev.onBranch !== next.onBranch) return false;
  if (prev.branchSwitch !== next.branchSwitch) return false;
  if (prev.onSwitchBranch !== next.onSwitchBranch) return false;

  // 流式相关：只有「正在流」和「本轮末条」还需要跟着逐帧/逐 tick 更新，
  // 其余历史行在上面的项全等时直接跳过，一个字节的正文都不重渲。
  if (next.live || next.isLastOfRound) {
    if (prev.tokensPerSecond !== next.tokensPerSecond) return false;
    if (prev.liveToolOutputs !== next.liveToolOutputs) return false;
    if (prev.roundProcess !== next.roundProcess) return false;
    if (prev.liveOutputFor !== next.liveOutputFor) return false;
  }
  return true;
}

const TurnRow = memo(TurnRowImpl, areTurnRowPropsEqual);

export function Transcript({
  messages,
  messageKeys,
  entryIds,
  onFork,
  forkingEntryId,
  busy,
  cwd,
  onOpenFile,
  onInsertCode,
  onApplyCode,
  applyTargetName,
  onBranch,
  branchSwitch,
  onSwitchBranch,
  nestedExecutions,
  revealTurn,
  liveTurn,
  tokensPerSecond,
  liveToolOutputs,
  precomputedTurns,
  streamingMessage,
}: {
  messages: AgentMessage[];
  /** 1:1 with `messages`：React 渲染用的稳定 key（下标会随插入平移，不能当下标用）。 */
  messageKeys?: Array<string | undefined>;
  /** 1:1 with `messages`; the session entry id used by `fork`/`navigate_tree`. */
  entryIds?: Array<string | undefined>;
  onFork?: (entryId: string) => void;
  forkingEntryId?: string | null;
  /**
   * 会话正在跑（流式 / 工具执行中）：
   * 宿主会拒绝 fork 与切分支（改文件、移叶子都会踩到半写入的 .jsonl），
   * 所以按钮保留但禁用 + 说明原因，别让人点了「像坏了一样」。
   */
  busy?: boolean;
  /** Project root for resolving relative file references. */
  cwd?: string | null;
  onOpenFile?: OpenFileHandler;
  onInsertCode?: InsertCodeHandler;
  /** Write a code block to the file currently open in the right panel. */
  onApplyCode?: (code: string, language?: string) => void;
  /** File name shown on the Apply button / confirmation dialog. */
  applyTargetName?: string | null;
  /** In-session branch at this message (GitBranch button). */
  onBranch?: (entryId: string) => void | Promise<void>;
  /** Sibling switcher info per message entry id (`1/2` arrows). */
  branchSwitch?: (entryId: string) => BranchSwitchInfo | null;
  onSwitchBranch?: (leafId: string | null) => void;
  /** Live nested tool results captured from SSE (not persisted by pi). */
  nestedExecutions?: Record<string, NestedExecutionView>;
  /** 导航点了某个尚未挂载的轮次：先把它拉进渲染窗口，再滚动过去。 */
  revealTurn?: number | null;
  /** 最后一轮是否正在流式输出：思考过程/执行日志据此显示「思考中/正在执行」。 */
  liveTurn?: boolean;
  /** 实时生成速度（tokens/s），显示在思考标题栏。 */
  tokensPerSecond?: number;
  /** 执行中工具的实时输出（toolName → 文本）。 */
  liveToolOutputs?: Record<string, string>;
  /**
   * 调用方已经算好的轮次列表（与右侧导航共用，避免对同一份 messages 算两遍）。
   * 必须是**冻结的历史**（不含 `streamingMessage`），否则历史行每帧换汤不换药，
   * `TurnRow` 的 memo 会全部失效。
   */
  precomputedTurns?: TranscriptTurnView[];
  /**
   * 正在流式输出的那一条消息（与 `messages` 分开传）：
   * `messages` 只在 message_end 时变化，因此历史轮次可以彻底冻结，
   * 流式期间只重算最后这一条。
   */
  streamingMessage?: AgentMessage | null;
}) {
  const { locale } = useI18n();
  /** 中文界面用人民币符号，其余用美元。 */
  const currencySymbol = locale.startsWith("zh") ? "¥" : "$";
  const markdownComponents = useMemo(
    () => createMarkdownComponents(cwd, onOpenFile, onInsertCode, onApplyCode, applyTargetName),
    [cwd, onOpenFile, onInsertCode, onApplyCode, applyTargetName],
  );
  const [copiedTurn, setCopiedTurn] = useState<number | null>(null);
  /** 「已复制」提示的定时器：卸载时必须清掉，否则切会话会遗留一堆待触发的 timer。 */
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  /** 引用恒定：`TurnRow` 的 memo 比较里直接比它的引用。 */
  const copyTurn = useCallback((index: number, text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedTurn(index);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => {
          copyTimerRef.current = null;
          setCopiedTurn(null);
        }, 1600);
      })
      .catch(() => {
        /* clipboard unavailable */
      });
  }, []);

  /**
   * 实时工具输出：值放 ref，读取走一个**引用恒稳定**的 getter。
   * 这样 `liveToolOutputs` 逐 tick 换新对象时，也不会把 memo 的 props 比炸。
   */
  const liveToolOutputsRef = useRef<Record<string, string>>({});
  liveToolOutputsRef.current = liveToolOutputs ?? EMPTY_TOOL_OUTPUTS;
  const liveOutputFor = useCallback(
    (toolName: string) => liveToolOutputsRef.current[toolName],
    [],
  );

  /** 历史轮次：`messages` 只在 message_end 变，流式期间引用稳定 → 引用冻结。 */
  const historyTurns = useMemo(() => buildTranscriptTurns(messages), [messages]);
  /** 流式轮次：每帧只重算这一条，并把 messageIndex 补上历史长度偏移。 */
  const streamingTurns = useMemo(() => {
    if (!streamingMessage) return [] as TranscriptTurnView[];
    const offset = messages.length;
    return buildTranscriptTurns([streamingMessage]).map((turn) => ({
      ...turn,
      messageIndex: turn.messageIndex + offset,
    }));
  }, [streamingMessage, messages.length]);
  /**
   * 渲染序列 = 冻结的历史 + 至多一条流式。
   * 历史一律用调用方给的 `precomputedTurns`（与导航共用同一份，且必须是冻结历史），
   * 没给才回落到自己算的 `historyTurns`；流式那条永远追加在末尾。
   */
  const turns = useMemo(() => {
    const base = precomputedTurns ?? historyTurns;
    return streamingTurns.length > 0 ? [...base, ...streamingTurns] : base;
  }, [precomputedTurns, historyTurns, streamingTurns]);

  /* ---------------- 增量挂载：首屏 20 轮，其余按需 ----------------
     会话刚打开时只渲染尾部窗口，避免一次性 parse/render 上千轮 markdown。
     头部起点在「首次超过窗口」时冻结，流式新增不会把已显示的轮次挤掉。 */
  const [extraEarlier, setExtraEarlier] = useState(0);
  const tailStart = Math.max(0, turns.length - (INITIAL_TURNS + extraEarlier));
  const [frozenStart, setFrozenStart] = useState<number | null>(null);
  useEffect(() => {
    if (frozenStart === null && turns.length > INITIAL_TURNS + extraEarlier) {
      setFrozenStart(turns.length - INITIAL_TURNS - extraEarlier);
    }
  }, [turns.length, extraEarlier, frozenStart]);
  const start = Math.max(0, (frozenStart ?? tailStart) - extraEarlier);

  /* 导航跳到更早的轮次时，先把目标轮次拉进渲染窗口（最多两轮收敛）。 */
  useEffect(() => {
    if (revealTurn == null) return;
    if (revealTurn >= start) return;
    setExtraEarlier((value) => value + (start - revealTurn));
  }, [revealTurn, start]);

  /* ---------------- 无限向上滚动：视口锚点 + 残差校正 ----------------
     往上塞历史会把当前内容整体顶下去，所以加载前后都对同一根「锚点」对齐：
     1. 触发瞬间记录**第一条可见轮次**相对视口的 top（没有轮次时退化为 scrollHeight）；
     2. DOM 提交后（useLayoutEffect，绘制前）按差值补 scrollTop；
     3. 再补最多两帧残差，吃掉图片/字体/折叠动画带来的二次回流。
     结果：用户正在看的那条消息在屏幕上纹丝不动，滚动条也不会猛地跳一下。 */
  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const anchorRef = useRef<{ el: HTMLElement; root: HTMLElement; top: number } | null>(null);
  const heightAnchorRef = useRef<{ el: HTMLElement; height: number } | null>(null);
  const loadingEarlierRef = useRef(false);
  const startRef = useRef(start);
  startRef.current = start;
  const hasTurns = turns.length > 0;

  /** 记录「第一条可见轮次」的屏幕位置，作为加载后的对齐基准。 */
  const captureAnchor = useCallback(() => {
    const el = scrollParentRef.current;
    if (!el) return;
    const rootTop = el.getBoundingClientRect().top;
    for (const node of el.querySelectorAll<HTMLElement>("[data-turn-role]")) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > rootTop) {
        anchorRef.current = { el: node, root: el, top: rect.top };
        heightAnchorRef.current = null;
        return;
      }
    }
    // 极端情况（还没渲染出轮次）：退回高度差补偿
    anchorRef.current = null;
    heightAnchorRef.current = { el, height: el.scrollHeight };
  }, []);

  const loadEarlier = useCallback(() => {
    if (loadingEarlierRef.current || startRef.current <= 0) return;
    captureAnchor();
    loadingEarlierRef.current = true;
    setExtraEarlier((value) => value + TURN_BATCH);
  }, [captureAnchor]);

  /* 提交后立即对齐（绘制前），随后再补两帧残差。 */
  useLayoutEffect(() => {
    let raf = 0;
    let frames = 0;
    const sync = () => {
      const anchor = anchorRef.current;
      const fallback = heightAnchorRef.current;
      let residual = 0;

      if (anchor) {
        if (!anchor.el.isConnected) {
          anchorRef.current = null;
        } else {
          residual = anchor.el.getBoundingClientRect().top - anchor.top;
          if (Math.abs(residual) >= 0.5) anchor.root.scrollTop += residual;
        }
      } else if (fallback) {
        const delta = fallback.el.scrollHeight - fallback.height;
        if (Math.abs(delta) >= 0.5) fallback.el.scrollTop += delta;
        fallback.height = fallback.el.scrollHeight;
      }

      if (anchorRef.current && Math.abs(residual) >= 0.5 && frames < 2) {
        frames += 1;
        raf = requestAnimationFrame(sync);
        return;
      }
      anchorRef.current = null;
      heightAnchorRef.current = null;
    };
    sync();
    return () => cancelAnimationFrame(raf);
  }, [extraEarlier]);

  /* 冷却：避免一次滚动里连环触发多个批次（每批都已锚定，不会移动视线）。 */
  useEffect(() => {
    if (!loadingEarlierRef.current) return;
    const timer = window.setTimeout(() => {
      loadingEarlierRef.current = false;
    }, 140);
    return () => window.clearTimeout(timer);
  }, [extraEarlier]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    let el: HTMLElement | null = sentinel.parentElement;
    while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
      el = el.parentElement;
    }
    const root = el;
    if (!root) return;
    scrollParentRef.current = root;

    const check = () => {
      if (loadingEarlierRef.current || startRef.current <= 0) return;
      // 非活动标签被 display:none 隐藏时 clientHeight 为 0：此时补历史没有任何
      // 视觉意义，只会把整段历史白挂到 DOM 上（切回来还停在最开头）。
      if (root.clientHeight === 0) return;
      const rootTop = root.getBoundingClientRect().top;
      const sentinelTop = sentinel.getBoundingClientRect().top;
      // 预加载区 = 视口上沿往上 600px 以内。**必须**写成 rootTop - sentinelTop：
      // 反过来（sentinelTop - rootTop）在「已经往下读了几千 px」时也是负数、
      // 恒 <= 600，于是滚动一次就每 140ms 补 20 轮，几秒内把整段历史全挂上来，
      // 每批都要重锚定 scrollTop —— 表现就是阅读时页面一直上下跳。
      if (rootTop - sentinelTop <= 600) loadEarlier();
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) check();
      },
      { root, rootMargin: "600px 0px 0px 0px" },
    );
    observer.observe(sentinel);

    // 兜底：插入后哨兵可能仍停在预加载区内，IntersectionObserver 不会重复回调
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        check();
      });
    };
    root.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      scrollParentRef.current = null;
      loadingEarlierRef.current = false;
    };
  }, [loadEarlier, hasTurns]);

  /**
   * 首屏贴底的兜底：Transcript 自己知道"内容第一次真的有高度"的时刻。
   *
   * 为什么不能只靠 ChatSurface：真实会话常常是「先渲染 loading → 几秒后
   * JSONL 读完 → markdown/代码高亮再撑高」，任何一次时机错位都让人停在最开头。
   * 这里用**多帧重试 + 用户上翻即收手**，把"打开就停在开头"这种竞态彻底消掉。
   */
  const settledRef = useRef(false);
  const settleCancelRef = useRef(false);
  useLayoutEffect(() => {
    if (settledRef.current || !hasTurns || revealTurn != null) return;
    const findScroller = (): HTMLElement | null => {
      if (scrollParentRef.current) return scrollParentRef.current;
      let node: HTMLElement | null = rootRef.current?.parentElement ?? null;
      while (node) {
        if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
        node = node.parentElement;
      }
      return null;
    };
    const root = findScroller();
    // 隐藏标签（display:none）尺寸为 0：不算"已贴底"，把一次性机会留给可见那一刻。
    if (!root || root.clientHeight === 0) return;
    settledRef.current = true;
    settleCancelRef.current = false;
    const timers: number[] = [];
    let raf = 0;
    let lastTop = root.scrollTop;
    const pin = () => {
      if (settleCancelRef.current) return;
      // 用户自己在往上滚（scrollTop 变小）：立刻让位。
      if (root.scrollTop < lastTop - 8) {
        settleCancelRef.current = true;
        return;
      }
      root.scrollTop = root.scrollHeight;
      lastTop = root.scrollTop;
    };
    pin();
    raf = requestAnimationFrame(pin);
    // 异步内容（markdown 高亮 / 图片 / 折叠块）会在不同时间点撑高，逐个补。
    for (const delay of [50, 150, 400, 900, 1600]) {
      timers.push(window.setTimeout(pin, delay));
    }
    return () => {
      cancelAnimationFrame(raf);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [hasTurns, revealTurn]);

  /**
   * 按「一轮对话」聚合过程：
   * 一条用户提问 + 之后的多条 assistant 消息（pi 常把工具调用单独存成一条消息）。
   * 这样同一轮里**只会渲染一个思考标题和一个工具标题**，工具也不会被拆散。
   */
  /**
   * 按 turn.messageIndex 取原始消息（流式那条从 streamingMessage 兜底）。
   * 用 ref 实现，使这个回调**引用恒稳定** —— 否则它每帧都变，
   * 任何依赖它的子组件/memo 都会永远失效。
   */
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const streamingRef = useRef<AgentMessage | null>(streamingMessage ?? null);
  streamingRef.current = streamingMessage ?? null;
  const messageAt = useCallback((messageIndex: number): AssistantMessage | undefined => {
    const history = messagesRef.current;
    return (messageIndex < history.length ? history[messageIndex] : streamingRef.current) as
      | AssistantMessage
      | undefined;
  }, []);

  /**
   * 逐轮身份缓存：`turns` 每帧都会重建，但**历史轮的 turn 对象引用是冻结的**。
   * 这里给每一轮单独记一份「参与计算的 turn 引用 / 消息区间」，
   * 只有真正变了的那一轮才重建对象，其余轮次原样复用 →
   * 传给 `TurnRow` 的 `roundProcess` / `usageTotals` 引用稳定，memo 才不会白比。
   */
  const roundCacheRef = useRef<{
    processes: Map<number, { turns: TranscriptTurnView[]; value: RoundProcess }>;
    totals: Map<
      number,
      { from: number; to: number; last: AgentMessage | undefined; value: RoundTotals }
    >;
  }>({ processes: new Map(), totals: new Map() });

  const roundInfo = useMemo(() => {
    const roundKeyOf: number[] = new Array(turns.length).fill(-1);
    const lastAssistantOfRound = new Map<number, number>();
    /** 每一轮里参与过程聚合的 assistant 轮次（按轮分组，给 process 缓存做失效判断）。 */
    const roundTurns = new Map<number, TranscriptTurnView[]>();
    let currentKey = -1;
    turns.forEach((turn, index) => {
      if (turn.role === "user") {
        currentKey = index;
        roundTurns.set(index, []);
        return;
      }
      if (currentKey < 0) return;
      roundKeyOf[index] = currentKey;
      lastAssistantOfRound.set(currentKey, index);
      roundTurns.get(currentKey)?.push(turn);
    });

    /** 聚合思考 / 工具：同轮的 turn 引用没变就直接复用上一帧的对象。 */
    const cache = roundCacheRef.current;
    const processes = new Map<number, RoundProcess>();
    const nextProcessCache = new Map<number, { turns: TranscriptTurnView[]; value: RoundProcess }>();
    for (const [key, group] of roundTurns) {
      const cached = cache.processes.get(key);
      if (cached && sameTurnRefs(cached.turns, group)) {
        processes.set(key, cached.value);
        nextProcessCache.set(key, cached);
        continue;
      }
      const value: RoundProcess = {
        groups: groupProcessBlocks(
          group.flatMap((turn) => {
            const usage = (messages[turn.messageIndex] as AssistantMessage | undefined)?.usage;
            const entryId = entryIds?.[turn.messageIndex];
            const timestamp = (messages[turn.messageIndex] as { timestamp?: number } | undefined)
              ?.timestamp;
            return turn.blocks.flatMap((block): ProcessBlock[] => {
              if (block.kind === "thinking") {
                return [
                  {
                    kind: "thinking",
                    thinking: { text: block.text, usage, entryId, timestamp },
                  },
                ];
              }
              if (block.kind === "tool") {
                return [{ kind: "tool", tool: { block, usage } }];
              }
              return [];
            });
          }),
        ),
      };
      processes.set(key, value);
      nextProcessCache.set(key, { turns: group, value });
    }
    cache.processes = nextProcessCache;

    /**
     * 整轮消耗按**消息区间**统计，而不是按 turns：
     * turns 会过滤掉"没有可渲染 block"的 assistant 消息，而最终回复的 usage
     * 恰恰可能落在这些消息上（导致只统计到工具那一条的 637 tokens）。
     * 区间 = [本轮用户消息下标, 下一条用户消息下标) 内的所有 assistant 消息。
     */
    const ranges: Array<{ key: number; from: number; to: number }> = [];
    turns.forEach((turn, index) => {
      if (turn.role !== "user") return;
      ranges.push({ key: index, from: turn.messageIndex, to: messages.length });
    });
    ranges.forEach((range, index) => {
      range.to = ranges[index + 1]?.from ?? messages.length;
    });

    /** 整轮合计（输入 + 输出 + 缓存读 + 缓存写）：区间没动就复用旧对象。 */
    const totals = new Map<number, RoundTotals>();
    const nextTotalsCache = new Map<
      number,
      { from: number; to: number; last: AgentMessage | undefined; value: RoundTotals }
    >();
    for (const range of ranges) {
      const last = messages[range.to - 1];
      const cached = cache.totals.get(range.key);
      if (cached && cached.from === range.from && cached.to === range.to && cached.last === last) {
        totals.set(range.key, cached.value);
        nextTotalsCache.set(range.key, cached);
        continue;
      }
      const value: RoundTotals = {
        tokens: 0,
        cost: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      for (let messageIndex = range.from; messageIndex < range.to; messageIndex += 1) {
        const message = messages[messageIndex] as
          | { role?: string; usage?: AssistantMessage["usage"] }
          | undefined;
        const usage = message?.usage;
        if (!usage || message?.role !== "assistant") continue;
        value.input += usage.input ?? 0;
        value.output += usage.output ?? 0;
        value.cacheRead += usage.cacheRead ?? 0;
        value.cacheWrite += usage.cacheWrite ?? 0;
        value.tokens +=
          (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        value.cost += usage.cost?.total ?? 0;
      }
      totals.set(range.key, value);
      nextTotalsCache.set(range.key, { from: range.from, to: range.to, last, value });
    }
    cache.totals = nextTotalsCache;

    return { roundKeyOf, processes, lastAssistantOfRound, totals };
  }, [turns, messages, entryIds]);

  /**
   * 开发期渲染基线：每帧 / 每次 turns 变化打一行，配合 `TurnRow` 内部的
   * `[render] turn N rendered M times` 就能看出历史行到底有没有被重渲。
   */
  const renderStatsRef = useRef({ updates: 0, historyTurns: 0 });
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    renderStatsRef.current.updates += 1;
    renderStatsRef.current.historyTurns = historyTurns.length;
    console.debug("[render] turns update", {
      updates: renderStatsRef.current.updates,
      historyTurns: historyTurns.length,
      streamingTurns: streamingTurns.length,
      visible: Math.max(0, turns.length - start),
    });
  }, [turns, historyTurns, streamingTurns, start]);

  if (turns.length === 0) {
    return <p className="py-10 text-center text-[13px] text-ink-faint">这段会话还没有可显示的对话</p>;
  }

  return (
    <div ref={rootRef}>
      {/* 顶部哨兵：透明、1px 高，不占视觉空间 */}
      <div ref={sentinelRef} aria-hidden="true" className="h-px w-full" />
      {turns.slice(start).map((turn, offset) => {
        const index = start + offset;
        const roundKey = roundInfo.roundKeyOf[index] ?? -1;
        const isLastOfRound =
          roundKey >= 0 && roundInfo.lastAssistantOfRound.get(roundKey) === index;
        // 同一轮里除最后一条 assistant 消息外，如果不含文字就没有内容可渲染
        // （它们的思考/工具已经聚合到本轮最后一个过程块里），直接跳过避免巨大留白。
        if (
          turn.role !== "user" &&
          !isLastOfRound &&
          !turn.blocks.some((block) => block.kind === "text" || block.kind === "image")
        ) {
          return null;
        }
        const messageIndex = turn.messageIndex;
        const entryId = entryIds?.[messageIndex];
        /** 只有最后一条属于「正在流式输出」，其余历史行一律稳定。 */
        const live = Boolean(liveTurn) && index === turns.length - 1;
        return (
          <TurnRow
            /* key 优先用调用方给的稳定 id（流式占位是常量 key）：
               下标会随"新 user 消息插入"而平移，用它做 key 会让 React 复用错节点，
               表现就是"新消息被塞进了上一条消息的 DOM 里"。 */
            key={messageKeys?.[messageIndex] ?? messageIndex}
            turn={turn}
            index={index}
            isLastOfRound={isLastOfRound}
            roundKey={roundKey}
            roundProcess={roundKey >= 0 ? roundInfo.processes.get(roundKey) : undefined}
            usageTotals={isLastOfRound && roundKey >= 0 ? roundInfo.totals.get(roundKey) : undefined}
            firstInList={offset === 0}
            markdownComponents={markdownComponents}
            currencySymbol={currencySymbol}
            locale={locale}
            copied={copiedTurn === index}
            usage={messageAt(messageIndex)?.usage}
            entryId={entryId}
            live={live}
            liveTurn={Boolean(liveTurn)}
            /* 实时输出 / 速度只对「正在流」的那条有意义：
               传给历史行既会把本次运行的输出串到旧卡片上，还会让它们逐 tick 重渲。 */
            tokensPerSecond={live ? tokensPerSecond : undefined}
            liveToolOutputs={live ? liveToolOutputs : undefined}
            liveOutputFor={liveOutputFor}
            nestedExecutions={nestedExecutions}
            cwd={cwd}
            onOpenFile={onOpenFile}
            onCopy={copyTurn}
            onFork={onFork}
            forking={Boolean(entryId) && forkingEntryId === entryId}
            busy={busy}
            onBranch={onBranch}
            branchSwitch={branchSwitch}
            onSwitchBranch={onSwitchBranch}
          />
        );
      })}
    </div>
  );
}

export default Transcript;
