"use client";

import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, GitFork, X } from "lucide-react";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";

const markdownComponents: Components = {
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mb-3 mt-5 text-[17px] font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2.5 mt-5 text-[15.5px] font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-4 text-[14.5px] font-semibold first:mt-0">{children}</h3>,
  ul: ({ children }) => <ul className="mb-3 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="mb-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-[#DCE6F8] pl-3 text-ink-muted">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent-strong underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-lg border border-[#E3E8F2] bg-[#F5F8FD] p-3 text-[12.5px] leading-6">
      {children}
    </pre>
  ),
  code: ({ className, children }) =>
    className ? (
      <code className="font-mono text-[12.5px]">{children}</code>
    ) : (
      <code className="rounded bg-[#EDF3FD] px-1 py-0.5 font-mono text-[0.9em] text-ink">{children}</code>
    ),
  hr: () => <hr className="my-5 border-[#E3E8F2]" />,
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-[#E3E8F2] px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-[#E3E8F2] px-2 py-1">{children}</td>,
};

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
  | { kind: "tool"; name: string; input: Record<string, unknown>; result?: ToolResultMessage };

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
}: {
  call: NestedCall;
  depth: number;
  tree: Map<string | null, NestedCall[]>;
}) {
  const children = tree.get(call.id) ?? [];
  const duration = formatDuration(call.durationMs);
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
        {call.status === "error" ? (
          <X size={10} strokeWidth={2.5} className="shrink-0 text-[#C2554E]" aria-label="失败" />
        ) : call.status === "unfinished" ? (
          <span className="shrink-0 text-[10px] text-ink-faint">未完成</span>
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
      {children.map((child) => (
        <NestedToolRow key={child.id} call={child} depth={depth + 1} tree={tree} />
      ))}
    </div>
  );
}

function ToolCallCard({
  name,
  input,
  result,
}: {
  name: string;
  input: Record<string, unknown>;
  result?: ToolResultMessage;
}) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(input);
  const hasArgs = Object.keys(input).length > 0;
  const hasDetails = hasArgs || Boolean(result);
  const duration = formatDuration(result?.durationMs);
  const nested = result?.nestedCalls;
  const tree = nested?.calls.length ? buildNestedTree(nested.calls) : null;
  const output = result ? resultText(result).trim() : "";

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
      {open && hasDetails && (
        <div className="border-t border-[#EDF1F7] bg-[#FBFCFE]">
          {tree && (
            <div className="border-b border-[#EDF1F7] px-1 py-1.5">
              <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                执行树
              </p>
              {(tree.get(null) ?? []).map((call) => (
                <NestedToolRow key={call.id} call={call} depth={0} tree={tree} />
              ))}
              {nested && !nested.complete && (
                <p className="px-2 pt-1 text-[10px] text-ink-faint">
                  部分子调用未记录（超出数量或体积上限）
                </p>
              )}
            </div>
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
}: {
  messages: AgentMessage[];
  /** 1:1 with `messages`; the session entry id used by `fork`/`navigate_tree`. */
  entryIds?: Array<string | undefined>;
  onFork?: (entryId: string) => void;
  forkingEntryId?: string | null;
}) {
  const results = toolResultsById(messages);

  const turns = messages
    .map((message, messageIndex) => {
      if (message.role === "user") {
        const text = userText(message).trim();
        return text ? { role: "user" as const, text, blocks: [] as TurnBlock[], messageIndex } : null;
      }
      if (message.role === "assistant") {
        const blocks = assistantBlocks(message, results);
        return blocks.length > 0 ? { role: "assistant" as const, text: "", blocks, messageIndex } : null;
      }
      if (message.role === "custom") {
        const text = userText(message).trim();
        return text ? { role: "assistant" as const, text, blocks: [] as TurnBlock[], messageIndex } : null;
      }
      return null;
    })
    .filter(
      (turn): turn is {
        role: "user" | "assistant";
        text: string;
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
        const forking = Boolean(entryId) && forkingEntryId === entryId;
        return (
        <article key={index} className="group mb-8 last:mb-0">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint">
              {turn.role === "user" ? "你" : "PiForge"}
            </span>
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

          {turn.role === "user" ? (
            <div className="whitespace-pre-wrap break-words rounded-xl border border-[#E7E9EE] bg-white px-4 py-3 text-[14px] leading-7 text-ink shadow-[0_1px_2px_rgba(17,17,17,0.03)]">
              {turn.text}
            </div>
          ) : (
            <div className="break-words text-[14px] leading-7 text-ink-soft">
              {turn.blocks.length === 0 ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {turn.text}
                </ReactMarkdown>
              ) : (
                turn.blocks.map((block, blockIndex) =>
                  block.kind === "text" ? (
                    <ReactMarkdown
                      key={blockIndex}
                      remarkPlugins={[remarkGfm]}
                      components={markdownComponents}
                    >
                      {block.text}
                    </ReactMarkdown>
                  ) : block.kind === "thinking" ? (
                    <ThinkingBlock key={blockIndex} text={block.text} />
                  ) : (
                    <ToolCallCard
                      key={blockIndex}
                      name={block.name}
                      input={block.input}
                      result={block.result}
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
