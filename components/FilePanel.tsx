"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  Bot,
  FileCode,
  GitBranch,
  Globe,
  PanelRightClose,
  Puzzle,
  SquareTerminal,
  Terminal,
  Users,
} from "lucide-react";
import { FileExplorer } from "./FileExplorer";
import { BrowserPanel } from "./BrowserPanel";
import { FloatingFileViewer, type FloatingFileTarget } from "./FloatingFileViewer";
import { GitPanel } from "./GitPanel";
import { ProcessPanel } from "./ProcessPanel";
import { TerminalPanel } from "./TerminalPanel";
import { SubagentPanel } from "./SubagentPanel";
import { HerdrPanel } from "./HerdrPanel";
import { PluginPanel } from "./PluginPanel";

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

type PanelTab = "files" | "git" | "browser" | "processes" | "terminal" | "agents" | "fleet" | "plugins";

const PANEL_TABS = [
  { id: "files" as const, label: "文件", Icon: FileCode },
  { id: "git" as const, label: "Git", Icon: GitBranch },
  { id: "browser" as const, label: "浏览器", Icon: Globe },
  { id: "processes" as const, label: "进程", Icon: Terminal },
  { id: "terminal" as const, label: "终端", Icon: SquareTerminal },
  { id: "agents" as const, label: "Agents", Icon: Bot },
  { id: "fleet" as const, label: "舰队", Icon: Users },
  { id: "plugins" as const, label: "插件", Icon: Puzzle },
];

export function FilePanel({
  cwd,
  openFile,
  gitOpenSignal = 0,
  explorerRefreshKey = 0,
  viewerRefreshKey = 0,
  onOpenFile,
  onOpenDiff,
  onCloseFile,
  onCollapse,
}: {
  cwd: string | null;
  openFile: FloatingFileTarget | null;
  /** Incremented by the chat status bar to reveal the Git tab. */
  gitOpenSignal?: number;
  /** Bumped on every active-tab change so the file tree re-reads its cwd. */
  explorerRefreshKey?: number;
  /** Bumped after an external write so the floating viewer refetches. */
  viewerRefreshKey?: number;
  onOpenFile?: (filePath: string, fileName: string, line?: number) => void;
  onOpenDiff?: (filePath: string, fileName: string) => void;
  onCloseFile?: () => void;
  onCollapse?: () => void;
}) {
  const [tab, setTab] = useState<PanelTab>("files");

  // Chat file links and tree clicks must always surface in the Files tab,
  // without touching the chat surface.
  useEffect(() => {
    if (openFile) setTab("files");
  }, [openFile]);

  // The chat status bar's "Git Diff" button focuses the dedicated Git tab.
  useEffect(() => {
    if (gitOpenSignal > 0) setTab("git");
  }, [gitOpenSignal]);

  // The agent navigating the built-in browser should be visible, not hidden
  // behind whichever tab the user is currently on.
  useEffect(() => {
    const revealBrowser = () => setTab("browser");
    window.addEventListener("piforge:browser-open", revealBrowser);
    return () => window.removeEventListener("piforge:browser-open", revealBrowser);
  }, []);

  // The spawn_agent tool card links here.
  useEffect(() => {
    const revealAgents = () => setTab("agents");
    window.addEventListener("piforge:agents-open", revealAgents);
    return () => window.removeEventListener("piforge:agents-open", revealAgents);
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
                  refreshKey={explorerRefreshKey}
                  onOpenFile={handleOpenFile}
                  onOpenDiff={handleOpenDiff}
                />
              ) : (
                <p className="px-3 py-2 text-[11px] text-ink-faint">暂无项目</p>
              )}
            </div>
            {openFile ? (
              <FloatingFileViewer
                target={openFile}
                cwd={cwd}
                refreshKey={viewerRefreshKey}
                onClose={() => onCloseFile?.()}
              />
            ) : null}
          </>
        )}

        {/* Git stays mounted so its list/diff state survives tab switches. */}
        <div className={tab === "git" ? "h-full" : "hidden"}>
          <GitPanel cwd={cwd} active={tab === "git"} />
        </div>

        {/*
          The browser panel stays mounted so Main can position its
          WebContentsView from the placeholder rect; visibility is switched by
          the active tab, and the view itself lives in Electron Main.
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

        {tab === "agents" && (
          <div className="h-full overflow-y-auto py-1">
            <SubagentPanel />
          </div>
        )}

        {tab === "fleet" && (
          <div className="h-full overflow-y-auto py-1">
            <HerdrPanel />
          </div>
        )}

        {tab === "plugins" && (
          <div className="h-full">
            <PluginPanel />
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
