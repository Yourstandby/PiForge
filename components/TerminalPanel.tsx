"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Eraser, SquareTerminal } from "lucide-react";
import { parseAnsi, type AnsiSpan } from "@/lib/ansi";
import type { TerminalBlock, TerminalBlockStatus } from "@/lib/terminal-log";

/**
 * Read-only terminal for the right panel.
 *
 * Two live sources, one chronological stream:
 *   - `run_bg` processes  → SSE /api/processes/events (streamed stdout/stderr)
 *   - `bash` / `powershell` tool calls → SSE /api/terminal/events
 *
 * ANSI SGR sequences are rendered as colors (lib/ansi.ts). 默认**不跟随**：
 * 新输出不会把视图拽走；只有在用户自己滚到底部时才恢复跟随。
 */

interface ManagedProcessSummary {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "failed";
  startedAt: number;
  logs: string[];
}

interface DisplayBlock {
  id: string;
  kind: "shell" | "process";
  title: string;
  cwd: string | null;
  text: string;
  status: TerminalBlockStatus;
  at: number;
}

/** Lines kept per block in the DOM; older output stays in the server buffer. */
const MAX_RENDER_LINES = 400;

function tailLines(text: string, maxLines: number): { text: string; clipped: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, clipped: false };
  return { text: lines.slice(lines.length - maxLines).join("\n"), clipped: true };
}

const STATUS_COLOR: Record<TerminalBlockStatus, string> = {
  running: "#2563eb",
  ok: "#16a34a",
  error: "#dc2626",
};

const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const spans = useMemo<AnsiSpan[]>(() => parseAnsi(text), [text]);
  return (
    <>
      {spans.map((span, index) => (
        <span
          key={index}
          style={{
            color: span.fg,
            backgroundColor: span.bg,
            fontWeight: span.bold ? 600 : undefined,
            fontStyle: span.italic ? "italic" : undefined,
            textDecoration: span.underline ? "underline" : undefined,
            opacity: span.dim ? 0.7 : undefined,
          }}
        >
          {span.text}
        </span>
      ))}
    </>
  );
});

const BlockView = memo(function BlockView({ block }: { block: DisplayBlock }) {
  const { text, clipped } = tailLines(block.text, MAX_RENDER_LINES);
  const prompt = block.kind === "shell" ? "$" : "▸";
  return (
    <div className="border-b border-dashed border-[#ECEEF3] px-2.5 py-1.5 last:border-b-0">
      <div className="flex items-start gap-1.5 font-mono text-[11px] leading-[1.5]">
        <span
          aria-hidden="true"
          className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: STATUS_COLOR[block.status] }}
        />
        <span className="shrink-0 text-ink-faint">{prompt}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-ink-muted" title={block.cwd ?? undefined}>
          {block.title}
        </span>
      </div>
      {(text || block.status === "running") && (
        <pre className="mt-1 max-h-[420px] overflow-auto whitespace-pre-wrap break-all pl-[18px] font-mono text-[11.5px] leading-[1.55] text-[#1f2937]">
          {clipped && (
            <span className="block pb-1 text-[10.5px] italic text-ink-faint">
              … 仅显示最后 {MAX_RENDER_LINES} 行
            </span>
          )}
          {text ? <AnsiText text={text} /> : <span className="text-ink-faint">运行中…</span>}
        </pre>
      )}
    </div>
  );
});

function toDisplayBlocks(
  shells: TerminalBlock[],
  processes: ManagedProcessSummary[],
): DisplayBlock[] {
  const blocks: DisplayBlock[] = shells.map((shell) => ({
    id: `shell:${shell.id}`,
    kind: "shell",
    title: shell.title,
    cwd: shell.cwd,
    text: shell.text,
    status: shell.status,
    at: shell.at,
  }));

  for (const process of processes) {
    if (process.logs.length === 0) continue;
    blocks.push({
      id: `process:${process.id}`,
      kind: "process",
      title: `${process.name} · ${process.command}`,
      cwd: process.cwd,
      text: process.logs.join("\n"),
      status: process.status === "running" ? "running" : process.status === "failed" ? "error" : "ok",
      at: process.startedAt,
    });
  }

  return blocks.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at - b.at));
}

export function TerminalPanel() {
  const [shells, setShells] = useState<TerminalBlock[]>([]);
  const [processes, setProcesses] = useState<ManagedProcessSummary[]>([]);
  const [stick, setStick] = useState(false);
  const [pending, setPending] = useState(false);
  const autoScrolledRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/terminal/events");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string; blocks?: TerminalBlock[] };
        if (data.blocks) setShells(data.blocks);
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => source.close();
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/processes/events");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { processes?: ManagedProcessSummary[] };
        if (data.processes) setProcesses(data.processes);
      } catch {
        /* ignore malformed frame */
      }
    };
    // Safety net when the proxy/browser drops the event stream.
    const fallback = window.setInterval(() => {
      void fetch("/api/processes", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { processes?: ManagedProcessSummary[] } | null) => {
          if (data?.processes) setProcesses(data.processes);
        })
        .catch(() => {});
    }, 10_000);
    return () => {
      source.close();
      window.clearInterval(fallback);
    };
  }, []);

  const blocks = useMemo(() => toDisplayBlocks(shells, processes), [shells, processes]);
  const last = blocks[blocks.length - 1];

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  // 默认不自动跳：只在第一次收到输出时滚到最新一行，之后交给用户。
  useEffect(() => {
    if (autoScrolledRef.current || blocks.length === 0) return;
    autoScrolledRef.current = true;
    const frame = window.requestAnimationFrame(() => scrollToBottom());
    return () => window.cancelAnimationFrame(frame);
  }, [blocks.length, scrollToBottom]);

  // 跟随模式：仅当用户自己滚到了底部，新输出才继续滚到底。
  useEffect(() => {
    if (stick) {
      const frame = window.requestAnimationFrame(() => scrollToBottom());
      return () => window.cancelAnimationFrame(frame);
    }
    if (blocks.length > 0) setPending(true);
  }, [stick, last?.id, last?.text, blocks.length, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    // 阈值收窄到 8px：轻微上滚不再被当成“贴底”而强行拉回。
    const atBottom = distance < 8;
    setStick(atBottom);
    if (atBottom) setPending(false);
  }, []);

  const clearLog = useCallback(async () => {
    try {
      await fetch("/api/terminal/events", { method: "DELETE" });
      setShells([]);
    } catch {
      // Clearing is best-effort; the SSE snapshot will resync.
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-gray-200/60 bg-[#F5F5F7] px-2 text-[10.5px] text-ink-faint">
        <SquareTerminal size={11} strokeWidth={1.9} aria-hidden="true" />
        <span className="truncate">
          {blocks.length === 0 ? "等待命令输出" : `${blocks.length} 段输出`}
        </span>
        <button
          type="button"
          onClick={() => void clearLog()}
          disabled={blocks.length === 0}
          title="清空终端日志"
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-40"
        >
          <Eraser size={10} strokeWidth={1.9} aria-hidden="true" />
          清空
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          role="log"
          aria-live="polite"
          aria-label="终端输出"
          className="h-full overflow-y-auto bg-white"
        >
          {blocks.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
              <SquareTerminal size={20} strokeWidth={1.4} className="text-ink-faint" aria-hidden="true" />
              <p className="text-[11.5px] text-ink-muted">暂无输出</p>
              <p className="max-w-[240px] text-[10.5px] leading-5 text-ink-faint">
                Agent 运行的 bash 命令与 run_bg 后台进程会在这里实时输出（支持 ANSI 颜色）。
              </p>
            </div>
          ) : (
            blocks.map((block) => <BlockView key={block.id} block={block} />)
          )}
        </div>

        {!stick && blocks.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setStick(true);
              setPending(false);
              scrollToBottom();
            }}
            className={`absolute bottom-2 right-2 flex h-6 items-center gap-1 rounded-full border px-2 text-[10.5px] shadow-[0_2px_8px_rgba(0,0,0,0.08)] backdrop-blur transition-colors ${
              pending
                ? "border-[#F0C59A] bg-[#FDF3E8] text-[#C2661A]"
                : "border-[#DCE3EE] bg-white/95 text-ink-muted hover:text-ink"
            }`}
          >
            <ArrowDown size={11} strokeWidth={2} aria-hidden="true" />
            {pending ? "新输出" : "底部"}
          </button>
        )}
      </div>
    </div>
  );
}

export default TerminalPanel;
