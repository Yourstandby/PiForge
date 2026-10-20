"use client";

import { Children, useCallback, useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, CornerDownLeft, GitBranch, GitFork, X } from "lucide-react";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";
import { diffStats } from "@/lib/diff-lines";
import type { BranchSwitchInfo } from "@/lib/session-branches-view";
import { isEditToolName, toolDiffPath, toolDiffRows } from "@/lib/tool-diff";
import { DiffRows } from "./DiffRows";
import { getFileName } from "@/lib/file-paths";
import {
  findFileReferences,
  parseFileReference,
  resolveFileReferencePath,
  resolveHrefFileReference,
  type FileReference,
} from "@/lib/file-links";

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
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

type TurnBlock =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "image"; src: string }
  | { kind: "tool"; name: string; input: Record<string, unknown>; result?: ToolResultMessage };

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

function ToolCallCard({
  name,
  input,
  result,
  details,
  nestedExecutions,
}: {
  name: string;
  input: Record<string, unknown>;
  result?: ToolResultMessage;
  details?: unknown;
  nestedExecutions?: Record<string, NestedExecutionView>;
}) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(input);
  const hasArgs = Object.keys(input).length > 0;
  const hasDetails = hasArgs || Boolean(result);
  const duration = formatDuration(result?.durationMs);
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

  return (
    <div className="my-2.5 overflow-hidden rounded-lg border border-[#E3E8F2] bg-white">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((value) => !value)}
        aria-expanded={hasDetails ? open : undefined}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left ${
          hasDetails ? "cursor-pointer transition-colors hover:bg-[#F7FAFF]" : "cursor-default"
        }`}
      >
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
          {summary || "（无参数）"}
        </span>
        {tree && (
          <span className="shrink-0 text-[10px] text-ink-faint">{nested?.calls.length} 子调用</span>
        )}
        {duration && (
          <span className="shrink-0 tabular-nums text-[10.5px] text-ink-faint">{duration}</span>
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
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={index}
              src={src}
              alt={`工具输出图片 ${index + 1}`}
              loading="lazy"
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
              <div className="max-h-72 overflow-auto border-t border-[#EDF1F7] bg-white">
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
              <pre className="max-h-64 overflow-auto px-3 pb-2 font-mono text-[11.5px] leading-5 text-ink-soft">
                {JSON.stringify(input, null, 2)}
              </pre>
            </details>
          )}
          {result && (
            <details className="border-b border-[#EDF1F7] last:border-b-0" open={!tree && !hasArgs}>
              <summary className="cursor-pointer select-none px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                原始输出{result.isError ? "（失败）" : ""}
              </summary>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all px-3 pb-2 font-mono text-[11.5px] leading-5 text-ink-soft">
                {output || "（空）"}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2.5 overflow-hidden rounded-lg border border-dashed border-[#E3E0D8] bg-[#FBFBF7]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[#F7F7F1]"
      >
        <span className="text-[10px] font-medium uppercase tracking-wider text-ink-faint">思考</span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
            {text.replace(/\s+/g, " ").trim().slice(0, 90)}
          </span>
        )}
        <ChevronDown
          size={12}
          strokeWidth={2}
          aria-hidden="true"
          className={`ml-auto shrink-0 text-ink-faint transition-transform duration-150 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <div className="max-h-72 overflow-y-auto border-t border-[#EFEDE6] px-3 py-2 text-[12px] leading-6 whitespace-pre-wrap text-ink-muted">
          {text}
        </div>
      )}
    </div>
  );
}

export function Transcript({
  messages,
  entryIds,
  onFork,
  forkingEntryId,
  cwd,
  onOpenFile,
  onInsertCode,
  onApplyCode,
  applyTargetName,
  onBranch,
  branchSwitch,
  onSwitchBranch,
  nestedExecutions,
}: {
  messages: AgentMessage[];
  /** 1:1 with `messages`; the session entry id used by `fork`/`navigate_tree`. */
  entryIds?: Array<string | undefined>;
  onFork?: (entryId: string) => void;
  forkingEntryId?: string | null;
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
}) {
  const results = toolResultsById(messages);
  const markdownComponents = useMemo(
    () => createMarkdownComponents(cwd, onOpenFile, onInsertCode, onApplyCode, applyTargetName),
    [cwd, onOpenFile, onInsertCode, onApplyCode, applyTargetName],
  );
  const [copiedTurn, setCopiedTurn] = useState<number | null>(null);

  const copyTurn = (index: number, text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedTurn(index);
        setTimeout(() => setCopiedTurn(null), 1600);
      })
      .catch(() => {
        /* clipboard unavailable */
      });
  };

  const turns = messages
    .map((message, messageIndex) => {
      if (message.role === "user") {
        const text = userText(message).trim();
        const images = contentImages((message as { content?: unknown }).content);
        return text || images.length > 0
          ? { role: "user" as const, text, images, blocks: [] as TurnBlock[], messageIndex }
          : null;
      }
      if (message.role === "assistant") {
        const blocks = assistantBlocks(message, results);
        return blocks.length > 0 ? { role: "assistant" as const, text: "", images: [] as string[], blocks, messageIndex } : null;
      }
      if (message.role === "custom") {
        const text = userText(message).trim();
        return text ? { role: "assistant" as const, text, images: [] as string[], blocks: [] as TurnBlock[], messageIndex } : null;
      }
      return null;
    })
    .filter(
      (turn): turn is {
        role: "user" | "assistant";
        text: string;
        images: string[];
        blocks: TurnBlock[];
        messageIndex: number;
      } => turn !== null,
    );

  if (turns.length === 0) {
    return <p className="py-10 text-center text-[13px] text-ink-faint">这段会话还没有可显示的对话</p>;
  }

  return (
    <div>
      {turns.map((turn, index) => {
        const entryId = entryIds?.[turn.messageIndex];
        // The very first message cannot be forked (nothing before it), and a
        // fork mid-stream would race the entry ids the SSE events don't carry.
        const canFork = Boolean(onFork && entryId) && turn.messageIndex > 0;
        const canBranch = Boolean(onBranch && entryId);
        const forking = Boolean(entryId) && forkingEntryId === entryId;
        const switcher = entryId && branchSwitch ? branchSwitch(entryId) : null;
        return (
        <article key={index} className="group mb-8 last:mb-0">
          <div className="mb-2 flex items-center justify-between gap-2">
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
              <span className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint">
                {turn.role === "user" ? "你" : "PiForge"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() =>
                copyTurn(
                  index,
                  turn.role === "user"
                    ? turn.text
                    : turn.blocks
                        .filter((block): block is Extract<TurnBlock, { kind: "text" }> => block.kind === "text")
                        .map((block) => block.text)
                        .join("\n\n"),
                )
              }
              title={copiedTurn === index ? "已复制" : "复制这段内容"}
              aria-label={copiedTurn === index ? "已复制" : "复制这段内容"}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-faint opacity-0 transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink focus:opacity-100 group-hover:opacity-100"
            >
              {copiedTurn === index ? (
                <Check size={11} strokeWidth={2.2} className="text-[#3E8A63]" aria-hidden="true" />
              ) : (
                <Copy size={11} strokeWidth={1.9} aria-hidden="true" />
              )}
              {copiedTurn === index ? "已复制" : "复制"}
            </button>
            {canBranch && (
              <button
                type="button"
                onClick={() => void onBranch!(entryId!)}
                title="从此消息开启新分支"
                aria-label="从此消息开启新分支"
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-faint opacity-0 transition-colors duration-150 hover:bg-[#ECECEF] hover:text-accent-strong focus:opacity-100 group-hover:opacity-100"
              >
                <GitBranch size={11} strokeWidth={1.9} aria-hidden="true" />
                分支
              </button>
            )}
            {canFork && (
              <button
                type="button"
                onClick={() => onFork!(entryId!)}
                disabled={forking}
                title={forking ? "正在创建会话…" : "从此处派生新会话"}
                aria-label={forking ? "正在创建会话" : "从此处派生新会话"}
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

          {turn.role === "user" ? (
            <div className="whitespace-pre-wrap break-words rounded-xl border border-[#E7E9EE] bg-white px-4 py-3 text-[14px] leading-7 text-ink shadow-[0_1px_2px_rgba(17,17,17,0.03)]">
              {turn.text && <FileLinkText text={turn.text} cwd={cwd} onOpenFile={onOpenFile} />}
              {turn.images.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {turn.images.map((src, imageIndex) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
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
              {turn.blocks.length === 0 ? (
                <ReactMarkdown {...MARKDOWN_PLUGINS} components={markdownComponents}>
                  {turn.text}
                </ReactMarkdown>
              ) : (
                turn.blocks.map((block, blockIndex) =>
                  block.kind === "text" ? (
                    <ReactMarkdown
                      key={blockIndex}
                      {...MARKDOWN_PLUGINS}
                      components={markdownComponents}
                    >
                      {block.text}
                    </ReactMarkdown>
                  ) : block.kind === "thinking" ? (
                    <ThinkingBlock key={blockIndex} text={block.text} />
                  ) : block.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={blockIndex}
                      src={block.src}
                      alt="模型输出图片"
                      className="my-2 max-h-80 rounded-lg border border-[#E3E8F2] object-contain"
                    />
                  ) : (
                    <ToolCallCard
                      key={blockIndex}
                      name={block.name}
                      input={block.input}
                      result={block.result}
                      details={block.result?.details}
                      nestedExecutions={nestedExecutions}
                    />
                  ),
                )
              )}
            </div>
          )}
        </article>
        );
      })}
    </div>
  );
}

export default Transcript;
