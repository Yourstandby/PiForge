"use client";

import { useCallback, useState, type CSSProperties } from "react";
import { Terminal } from "lucide-react";
import { FileExplorer } from "./FileExplorer";
import { ProcessPanel } from "./ProcessPanel";

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
  onOpenDiff,
}: {
  cwd: string | null;
  onOpenFile?: (filePath: string, fileName: string) => void;
  onOpenDiff?: (filePath: string, fileName: string) => void;
}) {
  const handleOpenFile = useCallback(
    (filePath: string, fileName: string) => {
      onOpenFile?.(filePath, fileName);
    },
    [onOpenFile],
  );

  const handleOpenDiff = useCallback(
    (filePath: string, fileName: string) => {
      onOpenDiff?.(filePath, fileName);
    },
    [onOpenDiff],
  );
  const [tab, setTab] = useState<"files" | "processes">("files");

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-l border-gray-200/60 bg-[#F5F5F7]">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-gray-200/60 px-3">
        <div className="flex items-center gap-0.5" role="tablist" aria-label="右侧面板">
          {([
            { id: "files" as const, label: "文件" },
            { id: "processes" as const, label: "进程" },
          ]).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`rounded-md px-1.5 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors duration-150 ${
                tab === item.id
                  ? "bg-[#E8EFFB] text-accent-strong"
                  : "text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
              }`}
            >
              <span className="flex items-center gap-1">
                {item.id === "processes" && (
                  <Terminal size={11} strokeWidth={1.9} aria-hidden="true" />
                )}
                {item.label}
              </span>
            </button>
          ))}
        </div>
        {cwd && (
          <span className="min-w-0 truncate text-[11px] text-ink-faint" title={cwd}>
            {folderName(cwd)}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1" style={explorerTokens}>
        {tab === "processes" ? (
          <ProcessPanel />
        ) : cwd ? (
          <FileExplorer key={cwd} cwd={cwd} onOpenFile={handleOpenFile} onOpenDiff={handleOpenDiff} />
        ) : (
          <p className="px-3 py-2 text-[11px] text-ink-faint">暂无项目</p>
        )}
      </div>
    </aside>
  );
}

export default FilePanel;
