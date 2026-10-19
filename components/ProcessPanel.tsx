"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ExternalLink, RotateCw, Square, Terminal, Trash2 } from "lucide-react";

interface ManagedProcessView {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "failed";
  pid: number | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  url: string | null;
  logs: string[];
}

const STATUS_DOT: Record<ManagedProcessView["status"], string> = {
  running: "#3E8A63",
  exited: "#9CA3AF",
  failed: "#C2554E",
};

const STATUS_LABEL: Record<ManagedProcessView["status"], string> = {
  running: "运行中",
  exited: "已退出",
  failed: "失败",
};

function ProcessCard({
  process,
  busy,
  onAction,
}: {
  process: ManagedProcessView;
  busy: boolean;
  onAction: (action: "stop" | "restart" | "remove", id: string) => void;
}) {
  const [logsOpen, setLogsOpen] = useState(process.status === "running" && process.logs.length > 0);

  return (
    <div className="mx-1.5 mb-1.5 rounded-lg border border-[#E7E9EE] bg-white px-2.5 py-2 shadow-[0_1px_2px_rgba(17,17,17,0.03)]">
      <div className="flex items-center gap-1.5">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: STATUS_DOT[process.status] }}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink" title={process.command}>
          {process.name}
        </span>
        <span className="shrink-0 text-[10px] text-ink-faint">{STATUS_LABEL[process.status]}</span>
      </div>
      <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-faint" title={process.command}>
        {process.command}
      </p>
      <div className="mt-1.5 flex items-center gap-1">
        {process.pid !== null && (
          <span className="text-[10px] text-ink-faint">PID {process.pid}</span>
        )}
        {process.url && (
          <a
            href={process.url}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 items-center gap-0.5 truncate text-[10px] text-accent-strong hover:underline"
            title={process.url}
          >
            <ExternalLink size={10} strokeWidth={2} aria-hidden="true" />
            {process.url.replace(/^https?:\/\//, "")}
          </a>
        )}
        <span className="flex-1" />
        {process.status === "running" ? (
          <button
            type="button"
            onClick={() => onAction("stop", process.id)}
            disabled={busy}
            title="停止进程"
            aria-label={`停止 ${process.name}`}
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[10.5px] text-ink-muted transition-colors hover:bg-[#FBEDEC] hover:text-[#B0443C] disabled:opacity-40"
          >
            <Square size={9} strokeWidth={1.5} fill="currentColor" aria-hidden="true" />
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onAction("remove", process.id)}
            disabled={busy}
            title="移除记录"
            aria-label={`移除 ${process.name}`}
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-40"
          >
            <Trash2 size={11} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onAction("restart", process.id)}
          disabled={busy}
          title="重启进程"
          aria-label={`重启 ${process.name}`}
          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[10.5px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-40"
        >
          <RotateCw size={10} strokeWidth={2} aria-hidden="true" />
          重启
        </button>
      </div>
      {process.logs.length > 0 && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setLogsOpen((value) => !value)}
            aria-expanded={logsOpen}
            className="flex w-full items-center gap-1 rounded text-[10px] text-ink-faint hover:text-ink-muted"
          >
            <ChevronDown
              size={10}
              strokeWidth={2}
              aria-hidden="true"
              className={logsOpen ? "rotate-180" : ""}
            />
            输出（最近 {Math.min(process.logs.length, 80)} 行）
          </button>
          {logsOpen && (
            <pre className="mt-1 max-h-52 overflow-auto rounded-md bg-[#F7F8FA] px-2 py-1.5 font-mono text-[10px] leading-4 text-ink-soft">
              {process.logs.slice(-80).join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function ProcessPanel() {
  const [processes, setProcesses] = useState<ManagedProcessView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/processes");
      if (!res.ok) return;
      const data = (await res.json()) as { processes?: ManagedProcessView[] };
      setProcesses(data.processes ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [load]);

  const handleAction = useCallback(
    async (action: "stop" | "restart" | "remove", id: string) => {
      setBusyId(id);
      try {
        await fetch("/api/processes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, id }),
        });
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  if (error) {
    return <p className="px-3 py-2 text-[11px] text-danger">{error}</p>;
  }

  return (
    <div className="flex flex-col pt-1">
      {processes.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-ink-faint">
          <p className="flex items-center gap-1">
            <Terminal size={12} strokeWidth={1.75} aria-hidden="true" />
            还没有后台进程
          </p>
          <p className="mt-1 leading-5">
            让 Agent 用 <code className="font-mono text-[10.5px]">run_bg</code> 启动 dev
            server，进程会显示在这里，可随时停止或重启。
          </p>
        </div>
      ) : (
        processes.map((process) => (
          <ProcessCard
            key={process.id}
            process={process}
            busy={busyId === process.id}
            onAction={handleAction}
          />
        ))
      )}
    </div>
  );
}

export default ProcessPanel;
