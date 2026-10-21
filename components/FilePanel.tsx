"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Bot,
  ChevronLeft,
  FileCode,
  GitBranch,
  Globe,
  Network,
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
import { OrchestratorPanel } from "./OrchestratorPanel";

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

type PanelTab = "files" | "git" | "browser" | "processes" | "terminal" | "agents" | "fleet" | "orchestrator" | "plugins";

/** 主标签：文件 / Git / 浏览器 / 进程 / 终端 / 舰队 / 编排。
 *  「插件」与「Agents」已迁移到左侧边栏底部工具栏，但仍然通过
 *  `piforge:panel-tab` 事件在此面板渲染（见 HIDDEN_TAB_LABELS）。 */
const PANEL_TABS = [
  { id: "files" as const, label: "文件", Icon: FileCode },
  { id: "git" as const, label: "Git", Icon: GitBranch },
  { id: "browser" as const, label: "浏览器", Icon: Globe },
  { id: "processes" as const, label: "进程", Icon: Terminal },
  { id: "terminal" as const, label: "终端", Icon: SquareTerminal },
  { id: "fleet" as const, label: "舰队", Icon: Users },
  { id: "orchestrator" as const, label: "编排", Icon: Network },
];

/** 从侧边栏进入、但不在标签栏常驻的视图。 */
const HIDDEN_TAB_LABELS: Partial<Record<PanelTab, { label: string; Icon: typeof Bot }>> = {
  agents: { label: "Agents", Icon: Bot },
  plugins: { label: "插件", Icon: Puzzle },
};

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
  // 内容区极窄时给一个折叠提示（垂直图标栏永远保留）
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      setContentWidth(entries[0]?.contentRect.width ?? el.clientWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const contentTooNarrow = contentWidth > 0 && contentWidth < 180;

  // 「插件 / Agents」是二级视图：进入时隐藏 Tab 栏，返回时回到进来之前的标签。
  const hiddenView = HIDDEN_TAB_LABELS[tab] ?? null;
  const lastPrimaryTabRef = useRef<PanelTab>("files");
  useEffect(() => {
    // 只在主标签上记录落点；进入二级视图时保持「从哪里来」
    if (!hiddenView) lastPrimaryTabRef.current = tab;
  }, [tab, hiddenView]);

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

  // 左侧边栏底部工具栏（插件 / Agents）通过这个事件切换面板标签。
  useEffect(() => {
    const onPanelTab = (event: Event) => {
      const detail = (event as CustomEvent<PanelTab>).detail;
      const all: string[] = [...PANEL_TABS.map((t) => t.id), ...Object.keys(HIDDEN_TAB_LABELS)];
      if (typeof detail === "string" && all.includes(detail)) setTab(detail as PanelTab);
    };
    window.addEventListener("piforge:panel-tab", onPanelTab);
    return () => window.removeEventListener("piforge:panel-tab", onPanelTab);
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
    <aside className="flex h-full min-h-0 w-full shrink-0 border-l border-gray-200/60 bg-[#F5F5F7]">
      {/* ---- 垂直活动栏（Activity Bar）：固定 44px，永不随内容滚动 ---- */}
      <nav
        aria-label="右侧面板"
        className="flex h-full w-11 shrink-0 flex-col items-center gap-0.5 border-r border-gray-200/60 bg-[#F5F5F7] py-1"
      >
        {/* 收起面板：固定在活动栏最顶端，样式/尺寸与其它图标一致 */}
        <button
          type="button"
          onClick={onCollapse}
          aria-label="收起右侧面板"
          title="收起右侧面板"
          className="mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
        >
          <PanelRightClose size={13} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <div className="mb-0.5 w-7 border-t border-gray-200/70" aria-hidden="true" />

        {PANEL_TABS.map(({ id, label, Icon }) => {
          const selected = tab === id;
          return (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={label}
              aria-current={selected ? "page" : undefined}
              onClick={() => setTab(id)}
              className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors duration-150 ${
                selected
                  ? "bg-[#E8EFFB] text-accent-strong"
                  : "text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
              }`}
            >
              {/* 激活指示：图标左侧蓝色竖条 */}
              {selected && (
                <span
                  aria-hidden="true"
                  className="absolute -left-1 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent"
                />
              )}
              <Icon size={15} strokeWidth={1.9} aria-hidden="true" />
            </button>
          );
        })}

        {/* 次要视图（插件 / Agents）：同样只占图标栏宽度，内容在右侧区域渲染 */}
        <div className="mt-1 w-7 border-t border-gray-200/70" aria-hidden="true" />
        {(["plugins", "agents"] as const).map((id) => {
          const { label, Icon } = HIDDEN_TAB_LABELS[id]!;
          const selected = tab === id;
          return (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={label}
              aria-current={selected ? "page" : undefined}
              onClick={() => setTab(id)}
              className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors duration-150 ${
                selected
                  ? "bg-[#E8EFFB] text-accent-strong"
                  : "text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
              }`}
            >
              {selected && (
                <span
                  aria-hidden="true"
                  className="absolute -left-1 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent"
                />
              )}
              <Icon size={15} strokeWidth={1.9} aria-hidden="true" />
            </button>
          );
        })}

      </nav>

      {/* ---- 内容区 ---- */}
      <div ref={contentRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {hiddenView && (
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-gray-200/60 px-2">
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-ink">
              <hiddenView.Icon size={13} strokeWidth={1.9} aria-hidden="true" className="shrink-0 text-accent-strong" />
              <span className="truncate">{hiddenView.label}</span>
            </div>
            <button
              type="button"
              onClick={() => setTab(lastPrimaryTabRef.current)}
              title="返回上一个面板"
              aria-label="返回上一个面板"
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
            >
              <ChevronLeft size={12} strokeWidth={2} aria-hidden="true" />
              返回
            </button>
          </div>
        )}

        {contentTooNarrow && (
          <div className="shrink-0 border-b border-gray-200/60 bg-white/70 px-2 py-1 text-[10.5px] leading-relaxed text-ink-faint">
            内容区过窄，可拖动左边缘加宽，或
            <button
              type="button"
              onClick={onCollapse}
              className="ml-0.5 underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              收起面板
            </button>
          </div>
        )}

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

        {tab === "orchestrator" && (
          <div className="h-full overflow-y-auto py-1">
            <OrchestratorPanel />
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
      </div>
    </aside>
  );
}

export default FilePanel;
