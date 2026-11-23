"use client";

/**
 * 右栏「舰队 / 编排」面板的手动派生入口。
 *
 * 背景：这两个面板原先只读，空态时只能等主 Agent 调 `herdr_spawn` /
 * `orchestrator_spawn`，人根本没有入口，于是永远是「集群为空」。
 * 这里补一个最小表单：名称（可留空自动取）+ 任务描述 → 走 Host 的
 * `herdr.spawn` / `orchestrator.spawn`（和模型调用同一条通道）。
 *
 * 只做展示与校验，请求由调用方发（各面板知道自己要打哪个接口）。
 */
import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";

export interface AgentSpawnDraft {
  name: string;
  task: string;
}

interface Props {
  /** 按钮文字（如「新建 Agent」）。 */
  label: string;
  /** 任务输入框占位。 */
  placeholder: string;
  /** 提交按钮文字。 */
  submitLabel: string;
  /** 表单下方的说明（成本 / 隔离提示）。 */
  hint?: string;
  /** 没有 cwd 时禁用并显示原因。 */
  disabledReason?: string | null;
  onSubmit: (draft: AgentSpawnDraft) => Promise<void>;
}

/** 名称留空时从任务里取一个短标题（与 Host 侧兜底一致，只求可读）。 */
function deriveName(task: string): string {
  const firstLine = task.split("\n").find((line) => line.trim().length > 0) ?? "";
  const trimmed = firstLine.trim().replace(/^[-*\d.\s]+/, "");
  return (trimmed || task.trim()).slice(0, 24);
}

export function AgentSpawnTrigger({ label, placeholder, submitLabel, hint, disabledReason, onSubmit }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setError(null);
  };

  const submit = async () => {
    const trimmedTask = task.trim();
    if (!trimmedTask) {
      setError("先写清任务，派生的 Agent 看不到当前对话。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim() || deriveName(trimmedTask), task: trimmedTask });
      setName("");
      setTask("");
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={Boolean(disabledReason)}
        title={disabledReason ?? label}
        className="mx-1.5 mb-1 flex items-center gap-1 self-start rounded-md border border-[#E7E9EE] bg-white px-1.5 py-1 text-[10.5px] text-ink-muted hover:bg-[#F5F7FB] hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="agent-spawn-trigger"
      >
        <Plus size={11} aria-hidden="true" />
        {label}
      </button>
    );
  }

  return (
    <div className="mx-1.5 mb-1 rounded-lg border border-[#E7E9EE] bg-white p-1.5" data-testid="agent-spawn-form">
      <div className="mb-1 flex items-center gap-1">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="名称（可留空）"
          maxLength={60}
          className="h-6 min-w-0 flex-1 rounded border border-[#E7E9EE] px-1.5 text-[11px] text-ink outline-none focus:border-accent"
          aria-label="Agent 名称"
        />
        <button
          type="button"
          onClick={close}
          disabled={busy}
          title="取消"
          aria-label="取消派生"
          className="flex h-5 w-5 items-center justify-center rounded text-ink-faint hover:bg-[#F1F3F7]"
        >
          <X size={11} aria-hidden="true" />
        </button>
      </div>
      <textarea
        value={task}
        onChange={(event) => setTask(event.target.value)}
        placeholder={placeholder}
        rows={4}
        className="w-full resize-y rounded border border-[#E7E9EE] px-1.5 py-1 text-[11px] leading-4 text-ink outline-none focus:border-accent"
        aria-label="Agent 任务"
      />
      {hint && <p className="mt-1 text-[10px] leading-4 text-ink-faint">{hint}</p>}
      {error && <p className="mt-1 text-[10px] leading-4 text-danger" data-testid="agent-spawn-error">{error}</p>}
      <div className="mt-1 flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !task.trim()}
          className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[10.5px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && <Loader2 size={10} className="animate-spin" aria-hidden="true" />}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

export default AgentSpawnTrigger;
