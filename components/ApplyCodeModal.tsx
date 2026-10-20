"use client";

import { useState } from "react";
import { CornerDownLeft, Loader2 } from "lucide-react";
import type { FloatingFileTarget } from "./FloatingFileViewer";
import { ModalSurface } from "./ModalSurface";
import { getRelativeFilePath } from "@/lib/file-paths";

type ApplyMode = "overwrite" | "append";

/**
 * Confirmation dialog for the Markdown code-block "应用" action.
 * The actual write happens in the Agent Host via /api/files/apply.
 */
export function ApplyCodeModal({
  target,
  code,
  language,
  cwd,
  onClose,
  onApplied,
}: {
  target: FloatingFileTarget;
  code: string;
  language?: string;
  cwd?: string | null;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [saving, setSaving] = useState<ApplyMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ApplyMode | null>(null);
  const lineCount = code ? code.split("\n").length : 0;
  const relative = getRelativeFilePath(target.filePath, cwd ?? undefined);

  const apply = async (mode: ApplyMode) => {
    if (saving) return;
    setSaving(mode);
    setError(null);
    try {
      const res = await fetch("/api/files/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target.filePath, content: code, mode }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDone(mode);
      onApplied();
      setTimeout(onClose, 900);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <ModalSurface
      panelClassName="t-modal is-open ui-dialog-surface flex w-full max-w-md flex-col overflow-hidden rounded-[14px]"
      ariaLabelledBy="apply-code-title"
    >
      <div className="flex items-center gap-2 border-b border-divider px-4 py-3">
        <CornerDownLeft size={14} strokeWidth={1.9} className="shrink-0 text-accent" aria-hidden="true" />
        <h3 id="apply-code-title" className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">
          应用代码到 {target.fileName}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="rounded px-2 py-1 text-[16px] leading-none text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3.5">
        <p className="text-[12.5px] leading-5 text-ink-muted">
          是否将代码应用到 <span className="font-medium text-ink">{target.fileName}</span>？
        </p>
        <div className="rounded-lg border border-border bg-[#F7F8FA] px-3 py-2">
          <p className="truncate font-mono text-[11px] text-ink-muted" title={relative}>
            {relative}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            {language ? `${language} · ` : ""}
            {lineCount} 行 · {code.length.toLocaleString("en-US")} 字符
          </p>
        </div>
        <p className="text-[11px] leading-4 text-ink-faint">
          覆盖会替换整个文件；追加会保留现有内容并在其后写入代码块。写入由 Agent Host 校验路径后原子完成。
        </p>
        {done && (
          <p role="status" className="text-[12px] text-[#3E8A63]">
            {done === "overwrite" ? "已覆盖写入。" : "已追加到文件末尾。"}
          </p>
        )}
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-divider px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void apply("append")}
          disabled={Boolean(saving) || Boolean(done)}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-50"
        >
          {saving === "append" && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
          追加到文件
        </button>
        <button
          type="button"
          onClick={() => void apply("overwrite")}
          disabled={Boolean(saving) || Boolean(done)}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving === "overwrite" && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
          覆盖文件
        </button>
      </div>
    </ModalSurface>
  );
}

export default ApplyCodeModal;
