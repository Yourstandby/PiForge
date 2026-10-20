"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  FileCode,
  Globe,
  PanelRightClose,
  SquareTerminal,
  Terminal,
} from "lucide-react";
import { FileExplorer } from "./FileExplorer";
import { BrowserPanel } from "./BrowserPanel";
import { FloatingFileViewer, type FloatingFileTarget } from "./FloatingFileViewer";
import { FloatingGitDiffViewer } from "./FloatingGitDiffViewer";
import { ProcessPanel } from "./ProcessPanel";
import { TerminalPanel } from "./TerminalPanel";

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
  openFile,
  gitDiffOpen = false,
  onOpenFile,
  onOpenDiff,
  onCloseFile,
  onCloseGitDiff,
  onCollapse,
}: {
  cwd: string | null;
  openFile: FloatingFileTarget | null;
  gitDiffOpen?: boolean;
  onOpenFile?: (filePath: string, fileName: string, line?: number) => void;
  onOpenDiff?: (filePath: string, fileName: string) => void;
  onCloseFile?: () => void;
  onCloseGitDiff?: () => void;
  onCollapse?: () => void;
}) {
  const [tab, setTab] = useState<PanelTab>("files");

  // Chat file links and tree clicks must always surface in the Files tab,
  // without touching the chat surface.
  useEffect(() => {
    if (openFile || gitDiffOpen) setTab("files");
  }, [openFile, gitDiffOpen]);

  // The agent navigating the built-in browser should be visible, not hidden
  // behind whichever tab the user is currently on.
  useEffect(() => {
    const revealBrowser = () => setTab("browser");
    window.addEventListener("piforge:browser-open", revealBrowser);
    return () => window.removeEventListener("piforge:browser-open", revealBrowser);
  }, []);

  const handleOpenFile = useCallback(
    (filePath: string, fileName: string, line?: number) => {
      setTab("files");
      onOpenFile?.(filePath, fileName, line);
    },
    [onOpenFile],
  );

  const handleOpenDiff = useCallback(
    (filePath: string, fileName: string) => {
      setTab("files");
      onOpenDiff?.(filePath, fileName);
    },
    [onOpenDiff],
  );

  // A screenshot needs the guest surface painted. When the agent asks for one
  // from another tab, briefly switch to the Browser tab and restore afterwards.
  const revealForCapture = useCallback(async (): Promise<(() => void) | undefined> => {
    if (tab === "browser") return undefined;
    const previous = tab;
    setTab("browser");
    // Give the webview a couple of frames to lay out and repaint.
    await new Promise((resolve) => setTimeout(resolve, 260));
    return () => setTab(previous);
  }, [tab]);

  return (
    <aside className="flex h-full min-h-0 w-full shrink-0 flex-col border-l border-gray-200/60 bg-[#F5F5F7]">
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

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === "files" && (
          <>
            <div className="h-full overflow-y-auto py-1" style={explorerTokens}>
              {cwd ? (
                <FileExplorer
                  key={cwd}
                  cwd={cwd}
                  onOpenFile={handleOpenFile}
                  onOpenDiff={handleOpenDiff}
                />
              ) : (
                <p className="px-3 py-2 text-[11px] text-ink-faint">暂无项目</p>
              )}
            </div>
            {gitDiffOpen ? (
              <FloatingGitDiffViewer
                cwd={cwd}
                onClose={() => onCloseGitDiff?.()}
              />
            ) : openFile ? (
              <FloatingFileViewer
                target={openFile}
                cwd={cwd}
                onClose={() => onCloseFile?.()}
              />
            ) : null}
          </>
        )}

        {/*
          The browser panel stays mounted while other tabs are active: the
          `<webview>` guest keeps running and keeps answering the `web_preview`
          bridge, so the agent can read the page even while the user is on the
          Files tab. It is hidden until the Browser tab (or a screenshot) asks
          for it.
        */}
        <div className={tab === "browser" ? "h-full" : "hidden"}>
          <BrowserPanel
            active={tab === "browser"}
            onBeforeCapture={revealForCapture}
          />
        </div>

        {tab === "processes" && (
          <div className="h-full overflow-y-auto py-1">
            <ProcessPanel />
          </div>
        )}

        {tab === "terminal" && (
          <div className="h-full">
            <TerminalPanel />
          </div>
        )}
      </div>
    </aside>
  );
}

export default FilePanel;
