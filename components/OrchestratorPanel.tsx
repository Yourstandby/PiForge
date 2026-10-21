"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, Loader2, Network, Square } from "lucide-react";
import type { OrchestratorTaskView } from "@contract/domains/orchestrator";

const STATUS_COLOR: Record<string, string> = {
  starting: "#9A6B1F",
  running: "#2F7A55",
  stopping: "#9A6B1F",
  stopped: "#9CA3AF",
  crashed: "#B0443C",
  exited: "#6B7280",
};

interface TreeNode {
  task: OrchestratorTaskView;
  children: TreeNode[];
}

function duration(task: OrchestratorTaskView): string {
  const ms = task.finishedAt ? task.durationMs : Date.now() - task.startedAt;
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Build a parent/child tree; roots are tasks directly owned by a main session. */
function buildTree(tasks: OrchestratorTaskView[]): TreeNode[] {
  const byId = new Map(tasks.map((task) => [task.id, { task, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    if (node.task.parentTaskId && byId.has(node.task.parentTaskId)) {
      byId.get(node.task.parentTaskId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.task.startedAt - b.task.startedAt);
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}

function Node({ node, depth, stopping, onStop }: { node: TreeNode; depth: number; stopping: string | null; onStop: (id: string) => void }) {
  const { task } = node;
  const [expanded, setExpanded] = useState(true);
  return (
    <div style={{ marginLeft: depth * 12 }} data-testid={`orchestrator-node-${task.id}`}>
      <div className="rounded-lg border border-[#E7E9EE] bg-white px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          {node.children.length > 0 ? (
            <button type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? "折叠" : "展开"} className="flex h-4 w-4 items-center justify-center rounded text-[10px] text-ink-faint hover:bg-[#F1F3F7]">
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="h-4 w-4" />
          )}
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[task.status] ?? "#9CA3AF" }} />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink" title={task.task}>{task.name}</span>
          {task.verification.verified ? (
            <span title={task.verification.reason} className="rounded-full border border-[#CBE6D5] bg-[#F2FBF5] px-1.5 py-0.5 text-[9.5px] font-medium text-[#2F7A55]">已验证</span>
          ) : (
            <span title={task.verification.reason} className="rounded-full border border-[#F0E0C2] bg-[#FFF9EE] px-1.5 py-0.5 text-[9.5px] font-medium text-[#9A6B1F]">未验证</span>
          )}
          <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">{duration(task)}</span>
          {!["stopped", "crashed", "exited"].includes(task.status) && (
            <button type="button" onClick={() => onStop(task.id)} disabled={stopping === task.id} title="停止 Worker" aria-label={`停止 ${task.name}`} className="flex h-4 w-4 items-center justify-center rounded text-ink-faint hover:bg-[#FDF6F5] hover:text-[#B0443C]">
              {stopping === task.id ? <Loader2 size={9} className="animate-spin" /> : <Square size={8} strokeWidth={0} fill="currentColor" />}
            </button>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2 pl-5 text-[10px] text-ink-faint">
          <span className="rounded bg-[#F5F5F7] px-1 py-0.5">{task.status}</span>
          {task.branchName && <span className="inline-flex items-center gap-0.5 truncate"><GitBranch size={9} />{task.branchName}</span>}
          {task.filesChanged.length > 0 && <span>{task.filesChanged.length} 个变更</span>}
          {task.workerPid && <span>pid {task.workerPid}</span>}
        </div>
        <p className="mt-1 truncate pl-5 font-mono text-[9.5px] text-ink-muted" title={task.cwd}>{task.cwd}</p>
        {task.error && <p className="mt-1 pl-5 text-[10px] text-danger">{task.error}</p>}
        {task.output && <p className="mt-1 line-clamp-2 pl-5 text-[10px] leading-4 text-ink-faint" title={task.output}>{task.output}</p>}
      </div>
      {expanded && node.children.map((child) => (
        <div key={child.task.id} className="mt-1">
          <Node node={child} depth={depth + 1} stopping={stopping} onStop={onStop} />
        </div>
      ))}
    </div>
  );
}

/** Read-only orchestration tree; worker lifecycle stays in the Host. */
export function OrchestratorPanel() {
  const [tasks, setTasks] = useState<OrchestratorTaskView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/orchestrator", { cache: "no-store" });
      const data = (await response.json()) as { tasks?: OrchestratorTaskView[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setTasks(data.tasks ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", load);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  const stop = useCallback(async (id: string) => {
    setStopping(id);
    try {
      await fetch("/api/orchestrator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", id }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(null);
    }
  }, [load]);

  const roots = useMemo(() => buildTree(tasks), [tasks]);

  return (
    <div className="flex flex-col gap-1 px-1.5 py-1" data-testid="orchestrator-panel">
      {error && <p className="px-1.5 text-[11px] text-danger">{error}</p>}
      {tasks.length === 0 ? (
        <p className="px-1.5 py-2 text-[11px] leading-5 text-ink-faint">
          <Network size={12} className="mr-1 inline" aria-hidden="true" />
          暂无 Worker。主 Agent 可用 <code className="font-mono text-[10.5px]">orchestrator_spawn</code> 在独立 Git worktree + 独立进程中并行执行任务。
        </p>
      ) : roots.map((root) => (
        <Node key={root.task.id} node={root} depth={0} stopping={stopping} onStop={(id) => void stop(id)} />
      ))}
    </div>
  );
}

export default OrchestratorPanel;
