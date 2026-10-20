"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  FileCode,
  FolderTree,
  Globe,
  PanelRightClose,
  SquareTerminal,
  Terminal,
  X,
} from "lucide-react";
import { FileExplorer } from "./FileExplorer";
import { FileViewer } from "./FileViewer";
import { ProcessPanel } from "./ProcessPanel";
import type { Tab } from "./TabBar";

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

type PanelTab = "files" | "browser" | "processes" | "terminal";

const PANEL_TABS = [
  { id: "files" as const, label: "文件", Icon: FileCode },
  { id: "browser" as const, label: "浏览器", Icon: Globe },
  { id: "processes" as const, label: "进程", Icon: Terminal },
  { id: "terminal" as const, label: "终端", Icon: SquareTerminal },
];

export function FilePanel({
  cwd,
  fileTabs,
  activeFileTabId,
  onSelectFileTab,
  onCloseFileTab,
  onOpenFile,
  onOpenDiff,
  onCollapse,
}: {
  cwd: string | null;
  fileTabs: Tab[];
  activeFileTabId: string | null;
  onSelectFileTab: (id: string) => void;
  onCloseFileTab: (id: string) => void;
  onOpenFile?: (filePath: string, fileName: string, line?: number) => void;
  onOpenDiff?: (filePath: string, fileName: string) => void;
  onCollapse?: () => void;
}) {
  const [tab, setTab] = useState<PanelTab>("files");
  const [showTree, setShowTree] = useState(true);
  const activeTab = fileTabs.find((item) => item.id === activeFileTabId) ?? null;

  // Chat file links / explorer opens must land in the right panel, never over
  // the chat area, and must bring the Files tab forward.
  useEffect(() => {
    if (!activeFileTabId) return;
    setTab("files");
    setShowTree(false);
  }, [activeFileTabId]);

  const handleOpenFile = useCallback(
    (filePath: string, fileName: string, line?: number) => {
      onOpenFile?.(filePath, fileName, line);
      setTab("files");
      setShowTree(false);
    },
    [onOpenFile],
  );

  const handleOpenDiff = useCallback(
    (filePath: string, fileName: string) => {
      onOpenDiff?.(filePath, fileName);
      setTab("files");
      setShowTree(false);
    },
    [onOpenDiff],
  );

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-l border-gray-200/60 bg-[#F5F5F7]">
      {/* Panel tabs: icon + label, full-width, selected = light blue + underline */}
      <div className="flex h-10 shrink-0 items-stretch border-b border-gray-200/60 bg-[#F5F5F7]">
        <div role="tablist" aria-label="右侧面板" className="flex min-w-0 flex-1 items-stretch">
          {PANEL_TABS.map(({ id, label, Icon }) => {
            const selected = tab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={selected}
                title={label}
                onClick={() => setTab(id)}
                className={`flex min-w-0 flex-1 items-center justify-center gap-1 border-b-2 px-0.5 text-[10.5px] transition-colors duration-150 ${
                  selected
                    ? "border-accent bg-[#E8EFFB] font-medium text-accent-strong"
                    : "border-transparent text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
                }`}
              >
                <Icon size={12} strokeWidth={1.9} aria-hidden="true" className="shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="收起右侧面板"
          title="收起右侧面板"
          className="flex w-7 shrink-0 items-center justify-center border-l border-gray-200/60 text-ink-faint transition-colors hover:bg-[#ECECEF] hover:text-ink"
        >
          <PanelRightClose size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      {tab === "files" && (
        <div className="flex min-h-0 flex-1 flex-col">
          {fileTabs.length > 0 && (
            <div className="flex h-8 shrink-0 items-center gap-1 border-b border-gray-200/60 bg-white/60 px-1">
              <button
                type="button"
                onClick={() => setShowTree(true)}
                title="显示文件树"
                aria-label="显示文件树"
                aria-pressed={showTree}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors ${
                  showTree
                    ? "bg-[#E8EFFB] text-accent-strong"
                    : "text-ink-faint hover:bg-[#ECECEF] hover:text-ink"
                }`}
              >
                <FolderTree size={12} strokeWidth={1.8} aria-hidden="true" />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                {fileTabs.map((item) => {
                  const selected = item.id === activeFileTabId && !showTree;
                  return (
                    <div
                      key={item.id}
                      className={`group flex h-6 min-w-0 shrink-0 items-center rounded pl-1.5 pr-0.5 text-[10.5px] transition-colors ${
                        selected
                          ? "bg-[#E8EFFB] text-accent-strong"
                          : "text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onSelectFileTab(item.id);
                          setShowTree(false);
                        }}
                        title={item.filePath}
                        className="max-w-[150px] truncate"
                      >
                        {item.label}
                      </button>
                      <button
                        type="button"
                        onClick={() => onCloseFileTab(item.id)}
                        aria-label={`关闭 ${item.label}`}
                        title="关闭"
                        className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-white/70 hover:text-ink"
                      >
                        <X size={9} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-hidden">
            {cwd && !showTree && activeTab ? (
              <FileViewer
                filePath={activeTab.filePath}
                cwd={cwd}
                gitDiff={activeTab.mode === "diff"}
                line={activeTab.line}
              />
            ) : cwd ? (
              <div className="h-full overflow-y-auto py-1" style={explorerTokens}>
                <FileExplorer
                  key={cwd}
                  cwd={cwd}
                  onOpenFile={handleOpenFile}
                  onOpenDiff={handleOpenDiff}
                />
              </div>
            ) : (
              <p className="px-3 py-2 text-[11px] text-ink-faint">暂无项目</p>
            )}
          </div>
        </div>
      )}

      {tab === "browser" && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <Globe size={22} strokeWidth={1.4} className="text-ink-faint" aria-hidden="true" />
          <p className="text-[12px] text-ink-muted">内置浏览器预留位置</p>
          <p className="text-[11px] leading-5 text-ink-faint">
            后续可在此接入 Electron WebContentsView，不影响中间聊天区。
          </p>
        </div>
      )}

      {tab === "processes" && (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <ProcessPanel />
        </div>
      )}

      {tab === "terminal" && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <SquareTerminal size={22} strokeWidth={1.4} className="text-ink-faint" aria-hidden="true" />
          <p className="text-[12px] text-ink-muted">终端预留位置</p>
          <p className="text-[11px] leading-5 text-ink-faint">
            后续可在此接入终端会话，保持右侧独立工作区。
          </p>
        </div>
      )}
    </aside>
  );
}

export default FilePanel;
