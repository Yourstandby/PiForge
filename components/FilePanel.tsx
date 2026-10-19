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
  "--bg-hover": "#f5f5f5",
  "--bg-elevated": "#ffffff",
  "--border": "#e5e5e5",
  "--text": "#171717",
  "--text-dim": "#a3a3a3",
  "--accent": "#171717",
  "--danger": "#dc2626",
  "--radius-control": "6px",
  "--font-mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as CSSProperties;

function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function FilePanel({ cwd }: { cwd: string | null }) {
  const handleOpenFile = useCallback(() => {
    // No viewer wired yet — the tree is here for navigation only.
  }, []);

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-l border-gray-200 bg-white">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-gray-100 px-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
          项目文件
        </span>
        {cwd && (
          <span className="min-w-0 truncate text-[11px] text-neutral-400" title={cwd}>
            {folderName(cwd)}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1" style={explorerTokens}>
        {cwd ? (
          <FileExplorer key={cwd} cwd={cwd} onOpenFile={handleOpenFile} />
        ) : (
          <p className="px-3 py-2 text-[11px] text-neutral-400">暂无项目</p>
        )}
      </div>
    </aside>
  );
}

export default FilePanel;
