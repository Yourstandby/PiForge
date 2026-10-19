"use client";

import { X } from "lucide-react";
import { McpConfigContent } from "./McpConfigModal";
import { ModalSurface } from "./ModalSurface";

export function McpSettingsModal({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  return (
    <ModalSurface ariaLabelledBy="mcp-settings-title">
      <div className="flex h-[76vh] w-[min(820px,92vw)] flex-col overflow-hidden rounded-2xl bg-white">
        <div className="flex shrink-0 items-center justify-between border-b border-[#EBEDF1] px-4 py-2">
          <span
            id="mcp-settings-title"
            className="text-[11px] font-medium uppercase tracking-wider text-ink-faint"
          >
            设置 · MCP 服务
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
          >
            <X size={15} strokeWidth={1.75} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <McpConfigContent cwd={cwd} />
        </div>
      </div>
    </ModalSurface>
  );
}

export default McpSettingsModal;
