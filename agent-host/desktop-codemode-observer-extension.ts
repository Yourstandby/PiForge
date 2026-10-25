/**
 * codemode 卡顿的可观测性：脚本超时/取消时打一行日志，说明槽位可能仍被占用。
 *
 * 背景：SDK 的 worker 池是整个进程共享的，脚本超时只要求 VM 停止，槽位要等 worker
 * 真正退出才释放。我们没有队列状态的接口（不 patch node_modules），所以这里从
 * `tool_execution_end` 的错误文案**推断**一行日志 —— 它不假装是实时槽位探针，
 * 文案里写明 inferred。
 *
 * 只读：不改参数、不改结果、不拦截任何调用。
 */
import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "./sdk-adapter.ts";
import { describeCodemodeFailure } from "../lib/codemode-progress.ts";
import { resolveCodemodeWorkerPool } from "./codemode-worker-pool.ts";

const CODEMODE_TOOL_NAME = "codemode";

function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}

export function createDesktopCodemodeObserverFactory(options?: {
  log?: (message: string) => void;
}): ExtensionFactory {
  const log = options?.log ?? ((message: string) => console.log(`[agent-host] ${message}`));
  return (pi: ExtensionAPI) => {
    pi.on("tool_execution_end", (event) => {
      if (event.toolName !== CODEMODE_TOOL_NAME || !event.isError) return;
      const pool = resolveCodemodeWorkerPool().value;
      const line = describeCodemodeFailure(textOf(event.result), pool);
      if (line) log(`[codemode] ${line}`);
    });
  };
}

export function desktopCodemodeObserverInlineExtension(options?: {
  log?: (message: string) => void;
}): InlineExtension {
  return {
    name: "desktop-codemode-observer",
    factory: createDesktopCodemodeObserverFactory(options),
  };
}
