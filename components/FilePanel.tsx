"use client";

import { useCallback, type CSSProperties } from "react";
import { FileExplorer } from "./FileExplorer";

/**
 * FileExplorer renders its rows with inline styles that read the legacy theme
 * variables. Those tokens were removed from globals.css during the rebuild, so
 * we expose the handful it needs on this panel's subtree only (no global CSS,
 * same neutral light palette).
 */
const explorerTokens = {
  "--bg-hover": "#E7E7EB",
  "--bg-elevated": "#ffffff",
  "--border": "#e5e5e5",
  "--text": "#1f2937",
  "--text-dim": "#9ca3af",
  "--accent": "#2563eb",
  "--danger": "#dc2626",
  "--radius-control": "6px",
  "--font-mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as CSSProperties;

function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function FilePanel({
  cwd,
  onOpenFile,
}: {
  cwd: string | null;
  onOpenFile?: (filePath: string, fileName: string) => void;
}) {
  const handleOpenFile = useCallback(
    (filePath: string, fileName: string) => {
      onOpenFile?.(filePath, fileName);
    },
    [onOpenFile],
  );

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-l border-gray-200/60 bg-[#F5F5F7]">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-gray-200/60 px-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          项目文件
        </span>
        {cwd && (
          <span className="min-w-0 truncate text-[11px] text-ink-faint" title={cwd}>
            {folderName(cwd)}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1" style={explorerTokens}>
        {cwd ? (
          <FileExplorer key={cwd} cwd={cwd} onOpenFile={handleOpenFile} />
        ) : (
          <p className="px-3 py-2 text-[11px] text-ink-faint">暂无项目</p>
        )}
      </div>
    </aside>
  );
}

export default FilePanel;
