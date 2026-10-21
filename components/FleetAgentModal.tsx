"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, FileJson, Loader2, X } from "lucide-react";
import type { FleetAgentProfile } from "@contract/domains/fleet";
import { FLEET_TOOL_CHOICES } from "@/lib/fleet-view";

/**
 * 新建 / 编辑常驻舰队 Agent 的配置弹窗。
 *
 * 三件事：填名字与 System Prompt、勾工具权限、以及「从 JSON 配置导入」。
 * 保存到 Host 后由 fleet-store 落盘（`<agentDir>/fleet/agents.json`），重启回显。
 */
export function FleetAgentModal({
  open,
  initial,
  busy,
  error,
  onClose,
  onSave,
  onImport,
}: {
  open: boolean;
  initial?: FleetAgentProfile | null;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (draft: {
    id?: string;
    name: string;
    systemPrompt: string;
    tools: string[];
    persistent: boolean;
  }) => void;
  onImport: (payload: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [tools, setTools] = useState<string[]>(FLEET_TOOL_CHOICES.map((tool) => tool.id));
  const [persistent, setPersistent] = useState(true);
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setSystemPrompt(initial?.systemPrompt ?? "");
    setTools(initial?.tools ?? FLEET_TOOL_CHOICES.map((tool) => tool.id));
    setPersistent(initial?.persistent ?? true);
    setImportError(null);
  }, [open, initial]);

  if (!open) return null;

  const toggleTool = (id: string) => {
    setTools((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      onImport(JSON.parse(text) as unknown);
      setImportError(null);
    } catch (e) {
      setImportError(e instanceof Error ? `解析失败：${e.message}` : "解析失败");
    }
  };

  const canSave = name.trim().length > 0 && systemPrompt.trim().length > 0 && tools.length > 0;

  return (
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-[rgba(17,17,17,0.28)] px-4"
      role="dialog"
      aria-modal="true"
      aria-label="新建舰队 Agent"
    >
      <div className="w-full max-w-[520px] overflow-hidden rounded-xl border border-[#E7E9EE] bg-white shadow-[0_18px_48px_rgba(17,17,17,0.16)]">
        <header className="flex items-center gap-2 border-b border-[#F0F1F4] px-4 py-3">
          <Bot size={14} strokeWidth={1.9} className="text-accent-strong" aria-hidden="true" />
          <h2 className="flex-1 text-[13px] font-medium text-ink">
            {initial ? "编辑舰队 Agent" : "新建舰队 Agent"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-6 w-6 items-center justify-center rounded text-ink-faint transition-colors hover:bg-[#F3F4F7] hover:text-ink"
          >
            <X size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>

        <div className="max-h-[70vh] space-y-3 overflow-y-auto px-4 py-3">
          <label className="block">
            <span className="text-[11px] font-medium text-ink-muted">名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：安全审计员"
              maxLength={60}
              className="mt-1 w-full rounded-lg border border-[#E3E6EC] px-2.5 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent/50 focus:ring-2 focus:ring-accent/15"
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-medium text-ink-muted">System Prompt</span>
            <textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              rows={6}
              maxLength={4_000}
              placeholder="这个 Agent 的角色、边界与输出要求（它看不到主对话，写全一点）。"
              className="mt-1 w-full resize-y rounded-lg border border-[#E3E6EC] px-2.5 py-2 font-mono text-[11.5px] leading-5 text-ink outline-none transition-colors focus:border-accent/50 focus:ring-2 focus:ring-accent/15"
            />
            <span className="mt-1 block text-right text-[10px] text-ink-faint">
              {systemPrompt.length} / 4000
            </span>
          </label>

          <fieldset>
            <legend className="text-[11px] font-medium text-ink-muted">工具权限</legend>
            <div className="mt-1 grid grid-cols-2 gap-1.5">
              {FLEET_TOOL_CHOICES.map((tool) => (
                <label
                  key={tool.id}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[#E7E9EE] px-2 py-1.5 text-[11.5px] text-ink transition-colors hover:bg-[#F7F9FC]"
                >
                  <input
                    type="checkbox"
                    checked={tools.includes(tool.id)}
                    onChange={() => toggleTool(tool.id)}
                    className="h-3 w-3 accent-[#2563EB]"
                  />
                  <code className="font-mono text-[10.5px]">{tool.id}</code>
                  <span className="truncate text-ink-faint">{tool.label}</span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-ink-faint">
              舰队 Agent 只能申请只读工具（写文件/跑命令仍由主 Agent 执行）。
            </p>
          </fieldset>

          <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink">
            <input
              type="checkbox"
              checked={persistent}
              onChange={(event) => setPersistent(event.target.checked)}
              className="h-3 w-3 accent-[#2563EB]"
            />
            派驻到舰队（常驻待命，写入 JSON 后重启自动回显）
          </label>

          <div className="flex items-center gap-2 rounded-lg border border-dashed border-[#E3E6EC] bg-[#FAFBFD] px-2.5 py-2">
            <FileJson size={13} strokeWidth={1.8} className="shrink-0 text-ink-faint" aria-hidden="true" />
            <span className="flex-1 text-[11px] text-ink-faint">
              也可以从现有 JSON 配置导入（单条 / 数组 / {"{profiles:[]}"}）
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded-md border border-[#E3E6EC] bg-white px-2 py-1 text-[11px] text-ink transition-colors hover:bg-[#F5F7FA]"
            >
              选择文件
            </button>
          </div>
          {importError && <p className="text-[11px] text-[#B0443C]">{importError}</p>}
          {error && <p className="text-[11px] text-[#B0443C]">{error}</p>}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[#F0F1F4] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2.5 py-1.5 text-[11.5px] text-ink-muted transition-colors hover:bg-[#F3F4F7]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canSave || busy}
            onClick={() =>
              onSave({
                ...(initial ? { id: initial.id } : {}),
                name: name.trim(),
                systemPrompt: systemPrompt.trim(),
                tools,
                persistent,
              })
            }
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
            {persistent ? "保存并派驻" : "仅保存配置"}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default FleetAgentModal;
