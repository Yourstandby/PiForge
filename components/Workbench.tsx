"use client";

import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { fetchSessions, invalidateSessions } from "@/lib/sessions-cache";
import { sessionScope } from "@/lib/session-scope";
import { parseCwdParam } from "@/lib/project-window";
import { Bot, CircleHelp, Puzzle, Settings } from "lucide-react";
import { getElectronApi } from "@/lib/electron-api";
import { resolveForkedSession } from "@/lib/fork-session-wait";
import { buildProjectWindowPath, resolveInitialView } from "@/lib/project-window";
import { useConfigHotReload } from "@/hooks/useConfigHotReload";
import { ChatSurface } from "./ChatSurface";
import { FilePanel } from "./FilePanel";
import { ModelsConfig } from "./ModelsConfig";
import { SessionExportModal } from "./SessionExportModal";
import { SessionSidebar } from "./SessionSidebar";
import { SessionTabBar, type SessionTabStatus } from "./SessionTabBar";
import { ExtensionsConfigModal } from "./ExtensionsConfigModal";
import { AutoRoutingConfig } from "./AutoRoutingConfig";
import { AuxModelsConfig } from "./AuxModelsConfig";
import { CustomProvidersConfig } from "./CustomProvidersConfig";
import { PluginsConfig } from "./PluginsConfig";
import { ApplyCodeModal } from "./ApplyCodeModal";
import { DevEnvironmentConfig } from "./DevEnvironmentConfig";
import { McpSettingsModal } from "./McpSettingsModal";
import { GeneralSettingsModal } from "./GeneralSettingsModal";
import type { FloatingFileTarget } from "./FloatingFileViewer";
import { SkillsConfig } from "./SkillsConfig";
import { HelpModal } from "./HelpModal";
import { TitleBar } from "./TitleBar";
import { TaskDoneToasts, type DoneTaskItem } from "./TaskDoneToasts";
import type { AgentRailDoneEvent } from "./AgentRailPanel";
import { projectNameOf } from "@/lib/agent-rail";
import { getSessionTitleEntry } from "@/lib/session-titles";

/** 上次使用的项目目录：决定首屏能否跳过等待会话列表 */
const LAST_CWD_KEY = "piforge.lastCwd";

function byModifiedDesc(a: SessionInfo, b: SessionInfo): number {
  return new Date(b.modified).getTime() - new Date(a.modified).getTime();
}

type SettingsModal = "general" | "skills" | "models" | "extensions" | "auto" | "aux" | "mcp" | "dev" | "providers" | "plugins" | null;

const MIN_RIGHT_PANEL_WIDTH = 280;
const MAX_RIGHT_PANEL_WIDTH = 800;
/** 左侧会话栏展开时的固定宽度（SessionSidebar w-[260px]）。 */
const LEFT_SIDEBAR_WIDTH = 260;
/** 聊天区最小可用宽度：右侧面板拉到这里就卡住，不再把聊天区挤窄。 */
const MIN_CHAT_WIDTH = 560;
/**
 * 窄视口阈值。低于它时左栏(260) + 聊天区(560) + 右栏(280) 已放不下，
 * 三个固定宽度会互相重叠成一坨（内置浏览器里预览本应用就是这个宽度）。
 * 因此改用浮层侧栏：聊天区独占宽度，侧栏按需覆盖在上面。
 */
const COMPACT_BREAKPOINT = 1080;
/** 浮层侧栏的最小宽度。 */
const COMPACT_PANEL_MIN_WIDTH = 320;
const RIGHT_PANEL_WIDTH_KEY = "piforge.rightPanelWidth";

/** 当前视口 / 侧边栏状态下，右侧面板允许的最大宽度。 */
function maxRightPanelWidth(viewportWidth: number, leftSidebarOpen: boolean): number {
  const available = Math.max(
    0,
    viewportWidth - (leftSidebarOpen ? LEFT_SIDEBAR_WIDTH : 0),
  );
  return Math.max(
    MIN_RIGHT_PANEL_WIDTH,
    Math.min(MAX_RIGHT_PANEL_WIDTH, Math.round(available - MIN_CHAT_WIDTH)),
  );
}

function clampRightPanelWidth(
  width: number,
  viewportWidth: number,
  leftSidebarOpen: boolean,
): number {
  const max = maxRightPanelWidth(viewportWidth, leftSidebarOpen);
  return Math.min(max, Math.max(MIN_RIGHT_PANEL_WIDTH, Math.round(width)));
}

/**
 * One open chat tab. `key` is stable for the tab's lifetime (even when a
 * not-yet-created session adopts a real session id), so the mounted
 * ChatSurface never remounts and streaming state is preserved.
 */
interface ChatTab {
  key: string;
  title: string;
  session: SessionInfo | null;
  newSessionCwd: string | null;
  /** localStorage bucket for the composer draft. */
  draftKey: string;
}

let tabSeq = 0;

function tabTitle(session: SessionInfo | null): string {
  if (!session) return "新会话";
  const name = session.name?.trim();
  if (name) return name;
  const first = session.firstMessage?.replace(/\s+/g, " ").trim();
  if (first) return first.length > 48 ? `${first.slice(0, 47)}…` : first;
  return "未命名会话";
}

function draftKeyFor(session: SessionInfo | null, newSessionCwd: string | null): string {
  return session ? `session:${session.id}` : `new:${newSessionCwd ?? ""}`;
}

function readStoredDraft(draftKey: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(`piforge.draft:${draftKey}`) ?? "";
  } catch {
    return "";
  }
}

function makeTab(session: SessionInfo | null, newSessionCwd: string | null): ChatTab {
  tabSeq += 1;
  return {
    key: `tab-${tabSeq}`,
    title: tabTitle(session),
    session,
    newSessionCwd,
    draftKey: draftKeyFor(session, newSessionCwd),
  };
}

/** Memoized so typing in one tab never re-renders the others. */
const ChatPane = memo(ChatSurface);

interface PaneHandlers {
  onDraftChange: (value: string) => void;
  onSessionCreated: (session: SessionInfo) => void;
  onNewSession: () => void;
  onActivityChange: (activity: "idle" | "running" | "waiting", summary?: string) => void;
}

export function Workbench() {
  const [tabs, setTabs] = useState<ChatTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Composer drafts per tab key; persisted to localStorage by draftKey.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const tabsRef = useRef<ChatTab[]>([]);
  const activeKeyRef = useRef<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<FloatingFileTarget | null>(null);
  // Bumped after an applied code block so the floating viewer refetches.
  const [fileViewerRefreshKey, setFileViewerRefreshKey] = useState(0);
  const [applyRequest, setApplyRequest] = useState<{
    code: string;
    language?: string;
    target: FloatingFileTarget;
  } | null>(null);
  const [gitTabSignal, setGitTabSignal] = useState(0);
  // Bumped when the models modal closes so a freshly added provider shows up
  // in the model picker without remounting the session.
  const [modelsVersion, setModelsVersion] = useState(0);
  // Sidebar refetch trigger (fork / delete / new session).
  const [sessionsVersion, setSessionsVersion] = useState(0);
  const [settingsModal, setSettingsModal] = useState<SettingsModal>(null);
  // 底栏徽章（SystemStatusMenu）只管展示，真正选版本在设置页：用事件请它开。
  useEffect(() => {
    const open = () => setSettingsModal("general");
    window.addEventListener("piforge:open-settings", open);
    return () => window.removeEventListener("piforge:open-settings", open);
  }, []);
  const [helpOpen, setHelpOpen] = useState(false);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [rightPanelWidth, setRightPanelWidth] = useState(560);
  /** 视口宽度：SSR/首帧与服务端保持一致，挂载后再同步真实值。 */
  const [viewportWidth, setViewportWidth] = useState(1440);
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  const rightPanelDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // 右侧面板宽度夹紧：受视口宽度 + 左侧栏展开状态约束，
  // 保证聊天区永远 >= MIN_CHAT_WIDTH，拖拽到临界点就卡住。
  const clampPanelWidth = useCallback(
    (width: number) =>
      clampRightPanelWidth(
        width,
        typeof window === "undefined" ? 1440 : window.innerWidth,
        leftSidebarOpen,
      ),
    [leftSidebarOpen],
  );

  // Responsive default + persisted user width.
  useEffect(() => {
    let saved: number | null = null;
    try {
      const raw = window.localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
      const parsed = raw ? Number(raw) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) saved = parsed;
    } catch {
      // storage disabled
    }
    const fallback = Math.min(800, Math.max(400, Math.round(window.innerWidth * 0.36)));
    setRightPanelWidth(clampRightPanelWidth(saved ?? fallback, window.innerWidth, true));
  }, []);

  // Re-clamp when the window shrinks or the left sidebar is toggled:
  // the chat column must never be squeezed below MIN_CHAT_WIDTH.
  useEffect(() => {
    const reclamp = () => {
      setViewportWidth(window.innerWidth);
      setRightPanelWidth((current) => clampPanelWidth(current));
    };
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [clampPanelWidth]);

  // 窄视口（窗口缩小，或在内置浏览器里预览本应用）首次挂载时只留聊天区。
  useEffect(() => {
    if (window.innerWidth <= COMPACT_BREAKPOINT) {
      setLeftSidebarOpen(false);
      setRightPanelOpen(false);
    }
  }, []);

  // 右侧面板限定标签：左侧边栏底部的「插件 / Agents」用它打开对应视图。
  const openPanelTab = useCallback((tab: "plugins" | "agents") => {
    setRightPanelOpen(true);
    window.dispatchEvent(new CustomEvent("piforge:panel-tab", { detail: tab }));
  }, []);

  const startRightPanelResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      rightPanelDragRef.current = { startX: event.clientX, startWidth: rightPanelWidth };
      setRightPanelResizing(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [rightPanelWidth],
  );

  const moveRightPanelResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = rightPanelDragRef.current;
      if (!drag) return;
      setRightPanelWidth(
        clampPanelWidth(drag.startWidth + drag.startX - event.clientX),
      );
    },
    [clampPanelWidth],
  );

  const endRightPanelResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = rightPanelDragRef.current;
      if (!drag) return;
      rightPanelDragRef.current = null;
      const finalWidth = clampPanelWidth(drag.startWidth + drag.startX - event.clientX);
      setRightPanelWidth(finalWidth);
      setRightPanelResizing(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // pointer already released
      }
      try {
        window.localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(finalWidth));
      } catch {
        // storage disabled
      }
    },
    [clampPanelWidth],
  );

  // ~/.pi/agent edits (models.json, auth.json, extensions, skills) are picked
  // up live: bump the model list key and refresh sessions without a restart.
  useConfigHotReload(() => {
    setModelsVersion((version) => version + 1);
    setSessionsVersion((version) => version + 1);
  });
  const [exportSessionId, setExportSessionId] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // ------------------------------------------------------------------ tabs
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.key === activeKey) ?? null,
    [tabs, activeKey],
  );
  const activeCwd = activeTab?.session?.cwd ?? activeTab?.newSessionCwd ?? cwd;

  // Switching tabs must re-read the tree even when two tabs share a cwd (an
  // agent may have changed files in between).
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  useEffect(() => {
    setExplorerRefreshKey((value) => value + 1);
  }, [activeKey]);

  const commitTabs = useCallback((next: ChatTab[]) => {
    // 同一 key 出现两次会让两个 pane 同时被判定为「活动」→ 并排渲染两份界面。
    // 这里做一次去重（后者覆盖前者的位置），从源头保证一个 key 只对应一个视图。
    const seen = new Set<string>();
    const deduped: ChatTab[] = [];
    for (const tab of next) {
      if (seen.has(tab.key)) continue;
      seen.add(tab.key);
      deduped.push(tab);
    }
    tabsRef.current = deduped;
    setTabs(deduped);
  }, []);

  const activateTab = useCallback((key: string) => {
    activeKeyRef.current = key;
    // 切换会话会挂载/重渲大量消息 DOM：标记为非紧急更新，点击先反馈、渲染可中断，
    // 避免主线程被一次长任务（成百上千轮 markdown）完全堵住。
    startTransition(() => {
      setActiveKey(key);
      // 切回前台即视为已读，清掉「后台已完成」绿点
      setTabActivity((previous) =>
        previous[key]?.done
          ? {
              ...previous,
              [key]: { ...previous[key], done: false, doneAt: undefined, summary: undefined },
            }
          : previous,
      );
    });
  }, []);

  /** Ctrl+Tab / Ctrl+Shift+Tab: cycle through the open session tabs. */
  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      const list = tabsRef.current;
      if (list.length < 2) return;
      const current = list.findIndex((tab) => tab.key === activeKeyRef.current);
      if (current === -1) return;
      const next = list[(current + direction + list.length) % list.length];
      if (next) activateTab(next.key);
    },
    [activateTab],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      // Ctrl/Cmd+B：折叠 / 展开左侧栏（万一误触折叠后也能一键回来）
      if (event.key.toLowerCase() === "b" && !event.shiftKey) {
        event.preventDefault();
        setLeftSidebarOpen((open) => !open);
        return;
      }
      if (event.key !== "Tab") return;
      event.preventDefault();
      cycleTab(event.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cycleTab]);

  const rememberDraft = useCallback((draftKey: string, value: string) => {
    try {
      if (value) window.localStorage.setItem(`piforge.draft:${draftKey}`, value);
      else window.localStorage.removeItem(`piforge.draft:${draftKey}`);
    } catch {
      // storage disabled: draft still works for this mount
    }
  }, []);

  const setDraftForTab = useCallback((key: string, value: string) => {
    setDrafts((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
    const tab = tabsRef.current.find((item) => item.key === key);
    if (tab) rememberDraft(tab.draftKey, value);
  }, [rememberDraft]);

  const openTab = useCallback((tab: ChatTab) => {
    // 同一个会话只允许存在一个标签页：并发 fork / 重复点击时，不再追加第二个
    // 同名 tab（旧行为会出现两个「你好」并导致 TabBar 布局抖动）。
    const sessionId = tab.session?.id;
    if (sessionId) {
      const existing = tabsRef.current.find((item) => item.session?.id === sessionId);
      if (existing) {
        activateTab(existing.key);
        return;
      }
    }
    commitTabs([...tabsRef.current, tab]);
    setDrafts((prev) => ({ ...prev, [tab.key]: readStoredDraft(tab.draftKey) }));
    activateTab(tab.key);
  }, [commitTabs, activateTab]);

  const closeTab = useCallback(
    (key: string) => {
      const prev = tabsRef.current;
      const index = prev.findIndex((tab) => tab.key === key);
      if (index < 0) return;
      const next = prev.filter((tab) => tab.key !== key);
      // 关标签 = 会话作用域结束：清掉它登记的定时器 / 观察者，防止泄漏。
      const closingSessionId = prev[index].session?.id;
      if (closingSessionId) sessionScope.disposeSession(closingSessionId);
      // 关掉的标签不再需要状态指示灯数据
      setTabActivity((activity) => {
        if (!activity[key]) return activity;
        const rest = { ...activity };
        delete rest[key];
        return rest;
      });

      if (next.length === 0) {
        // Closing the last tab lands on a fresh session tab, like a browser.
        const fresh = makeTab(null, cwd);
        commitTabs([fresh]);
        setDrafts((drafts) => ({ ...drafts, [fresh.key]: readStoredDraft(fresh.draftKey) }));
        activateTab(fresh.key);
        return;
      }

      commitTabs(next);
      if (activeKeyRef.current === key) {
        activateTab(next[Math.min(index, next.length - 1)].key);
      }
    },
    [commitTabs, activateTab, cwd],
  );

  // ------------------------------------------------------------------ files
  const handleOpenFile = useCallback(
    (filePath: string, fileName: string, line?: number) => {
      // 文件优先：右栏收起时也要立刻展开，否则点了看不到任何东西。
      setRightPanelOpen(true);
      setOpenFile({ filePath, fileName, line });
    },
    [],
  );

  const handleOpenDiff = useCallback((filePath: string, fileName: string) => {
    setRightPanelOpen(true);
    setOpenFile({ filePath, fileName, diff: true });
  }, []);

  // The status bar's Git button focuses the right panel's Git tab.
  const handleOpenGitDiff = useCallback(() => {
    setRightPanelOpen(true);
    setGitTabSignal((value) => value + 1);
  }, []);

  const handleCloseFile = useCallback(() => setOpenFile(null), []);

  /** Apply a Markdown code block to the file open in the right panel. */
  const handleApplyCode = useCallback((code: string, language?: string) => {
    if (!openFile || openFile.diff) return;
    setApplyRequest({ code, language, target: openFile });
  }, [openFile]);

  const handleInsertCode = useCallback((code: string, language?: string) => {
    const key = activeKeyRef.current;
    if (!key) return;
    const fenced = `\`\`\`${language ?? ""}
${code}
\`\`\``;
    setDrafts((prev) => {
      const current = prev[key] ?? "";
      const next = current.trim()
        ? `${current.replace(/\s+$/, "")}

${fenced}`
        : fenced;
      const tab = tabsRef.current.find((item) => item.key === key);
      if (tab) rememberDraft(tab.draftKey, next);
      return { ...prev, [key]: next };
    });
  }, [rememberDraft]);

  // 记住上一个项目，下次启动可以跳过等待会话列表直接出首屏。
  useEffect(() => {
    if (!cwd) return;
    try {
      window.localStorage.setItem(LAST_CWD_KEY, cwd);
    } catch {
      // 隐私模式 / 配额满：只是少一个加速项，不影响功能
    }
  }, [cwd]);

  const loadSessions = useCallback(async (force = false): Promise<SessionInfo[]> => {
    try {
      const sessions = await fetchSessions({ force });
      return [...sessions].sort(byModifiedDesc);
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // 首屏不等 /api/sessions（它要扫盘统计每个会话）：深链 cwd 或上次项目
    // 都能立刻开一个空白会话，列表随后到达只负责填充侧栏。
    const params = new URLSearchParams(window.location.search);
    const linkedCwd = parseCwdParam(params.get("cwd"));
    const eagerCwd =
      linkedCwd ??
      (params.get("session") ? null : parseCwdParam(window.localStorage.getItem(LAST_CWD_KEY)));
    if (eagerCwd && tabsRef.current.length === 0) {
      setCwd(eagerCwd);
      openTab(makeTab(null, eagerCwd));
    }
    const initialize = async (sorted: SessionInfo[]) => {
      // Strict-mode double mount / hot reload must not open duplicate tabs.
      if (tabsRef.current.length > 0) return;

      const view = resolveInitialView(window.location.search, sorted);
      if (view.kind === "project") {
        // Electron opens `/?cwd=<project>` for a new project window: start a
        // blank session in that folder, not the newest on-disk session.
        setCwd(view.cwd);
        openTab(makeTab(null, view.cwd));
        return;
      }
      if (view.kind === "session") {
        setCwd(view.session.cwd);
        openTab(makeTab(view.session, null));
        return;
      }
      // Nothing selected: the hero composer is a brand-new session in the
      // most recent project, so the first message can be sent immediately.
      setCwd((current) => current ?? view.cwd);
      if (view.cwd) {
        openTab(makeTab(null, view.cwd));
        return;
      }
      // No project at all: ask the server for a default so the first prompt
      // still has somewhere to run.
      let fallback: string | null = null;
      try {
        const res = await fetch("/api/default-cwd", { method: "POST" });
        if (res.ok) fallback = ((await res.json()) as { cwd?: string }).cwd ?? null;
      } catch {
        // Keep the empty-project hero; the server will reject the first send.
      }
      if (cancelled) return;
      if (fallback) setCwd(fallback);
      openTab(makeTab(null, fallback));
    };

    void loadSessions().then((sorted) => {
      if (cancelled) return;
      void initialize(sorted);
    });
    return () => {
      cancelled = true;
    };
  }, [loadSessions, openTab]);

  /**
   * Sidebar click: open the session in its own tab. Clicking an already-open
   * session just focuses that tab, and the current chat is never replaced.
   */
  const handleSelect = useCallback(
    (session: SessionInfo) => {
      const existing = tabsRef.current.find((tab) => tab.session?.id === session.id);
      if (existing) {
        activateTab(existing.key);
        if (session.cwd) setCwd(session.cwd);
        return;
      }
      // 新建标签 = 挂载一整棵新的 ChatSurface，同样放到非紧急更新里，
      // 保证侧栏点击的手感不被一次性渲染卡死。
      startTransition(() => {
        openTab(makeTab(session, null));
        if (session.cwd) setCwd(session.cwd);
      });
    },
    [activateTab, openTab],
  );

  const handleNewSession = useCallback(async (targetCwd?: string) => {
    let target = targetCwd ?? activeCwd;
    if (!target) {
      try {
        const res = await fetch("/api/default-cwd", { method: "POST" });
        if (res.ok) {
          const data = (await res.json()) as { cwd?: string };
          target = data.cwd ?? null;
        }
      } catch {
        // Without a project folder there is nothing to create a session in.
      }
    }
    // A brand-new session tab can live without a project; the server picks
    // the default cwd when the first message is sent.
    if (target) setCwd(target);
    openTab(makeTab(null, target ?? null));
  }, [activeCwd, openTab]);

  /**
   * Picks a local folder and opens it as its own project window. In Electron
   * this goes through the preload bridge (`electronAPI.selectDirectory` /
   * `electronAPI.openWindow`); the browser dev build falls back to the
   * server-side Windows picker plus a new tab.
   */
  const handleAddProject = useCallback(async () => {
    setProjectError(null);
    const api = getElectronApi();

    let dir: string | null = null;
    if (api) {
      try {
        dir = await api.selectDirectory();
      } catch {
        setProjectError("无法打开文件夹选择器");
        return;
      }
    } else {
      try {
        const res = await fetch("/api/select-directory", { method: "POST" });
        if (!res.ok) {
          setProjectError("无法打开文件夹选择器");
          return;
        }
        dir = ((await res.json()) as { path?: string | null }).path ?? null;
      } catch {
        setProjectError("无法打开文件夹选择器");
        return;
      }
    }
    if (!dir) return;

    const path = buildProjectWindowPath(dir);
    if (api?.openWindow) {
      await api.openWindow(path);
      return;
    }
    window.open(path, "_blank", "noopener");
  }, []);

  /**
   * A prompt created a real session for a "新会话" tab: adopt its identity
   * without remounting the pane (streaming state stays intact).
   */
  const handleSessionCreated = useCallback(
    (key: string, created: SessionInfo) => {
      const tab = tabsRef.current.find((item) => item.key === key);
      if (!tab) return;
      const nextDraftKey = draftKeyFor(created, null);
      if (tab.draftKey !== nextDraftKey) {
        const stored = readStoredDraft(tab.draftKey);
        if (stored) rememberDraft(nextDraftKey, stored);
        rememberDraft(tab.draftKey, "");
      }
      commitTabs(
        tabsRef.current.map((item) =>
          item.key === key
            ? { ...item, session: created, newSessionCwd: null, title: tabTitle(created), draftKey: nextDraftKey }
            : item,
        ),
      );
      if (created.cwd) setCwd(created.cwd);
      setSessionsVersion((version) => version + 1);
      // The background auto-title finishes a few seconds into the first turn.
      // If its SSE event raced the sidebar's first refresh (or the stream was
      // reconnected), this one-shot refetch still picks the name up.
      // 会话作用域定时器：标签关掉就自动取消，别让孤儿回调继续拉列表。
      sessionScope.setTimeout(
        created.id,
        () => {
          // 侧栏只认 sessionsVersion：单纯 fetch 一次没人用，标题/时间就永远不更新。
          // 只 bump 一次（不传 showLoading），列表不会被卸载重挂，也不会抖两下。
          invalidateSessions();
          setSessionsVersion((version) => version + 1);
        },
        6_000,
      );
    },
    [commitTabs, rememberDraft],
  );

  /** Keep tab titles in sync with auto-title / rename events. */
  const handleSessionRenamed = useCallback(async () => {
    setSessionsVersion((version) => version + 1);
    invalidateSessions();
    const sorted = await loadSessions(true);
    const byId = new Map(sorted.map((item) => [item.id, item]));
    commitTabs(
      tabsRef.current.map((tab) => {
        const fresh = tab.session ? byId.get(tab.session.id) : null;
        return fresh ? { ...tab, title: tabTitle(fresh) } : tab;
      }),
    );
  }, [commitTabs, loadSessions]);

  /**
   * A fork / branch-clone writes a new `.jsonl` server-side; the sidebar may not
   * see it for a moment, so resolve it with retries and then open it as a tab.
   */
  const handleSessionForked = useCallback(
    async (newSessionId: string) => {
      const found = await resolveForkedSession(
        newSessionId,
        async () => {
          try {
            const res = await fetch("/api/sessions");
            if (!res.ok) return [];
            const data = (await res.json()) as { sessions?: SessionInfo[] };
            return data.sessions ?? [];
          } catch {
            return [];
          }
        },
        async (id) => {
          try {
            const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
            if (!res.ok) return null;
            const data = (await res.json()) as { info?: SessionInfo | null };
            return data.info ?? null;
          } catch {
            return null;
          }
        },
      );
      const sorted = await loadSessions();
      setSessionsVersion((version) => version + 1);
      const target = found ?? sorted.find((item) => item.id === newSessionId) ?? null;
      if (!target) return;
      handleSelect(target);
    },
    [handleSelect, loadSessions],
  );

  /** A deleted session closes its tab(s); the chat area falls back to another. */
  const handleSessionDeleted = useCallback(
    (sessionId: string) => {
      const affected = tabsRef.current.filter((tab) => tab.session?.id === sessionId);
      if (affected.length > 0) {
        affected.forEach((tab) => closeTab(tab.key));
      }
      void loadSessions();
    },
    [closeTab, loadSessions],
  );

  /** File links in any transcript always land in the right panel. */
  const handleOpenChatFile = useCallback(
    (filePath: string, fileName: string, line?: number) => {
      handleOpenFile(filePath, fileName, line);
    },
    [handleOpenFile],
  );

  // Per-tab callbacks are cached by tab key so ChatPane's memo() holds: typing
  // in one tab only re-renders that tab.
  /**
   * 后台标签状态：live = 引擎实时状态；done = 后台跑完但用户还没切回去看。
   * 只在真正变化时才 setState，避免流式事件把 Workbench 也一起重渲染。
   */
  const [tabActivity, setTabActivity] = useState<
    Record<
      string,
      { live: "idle" | "running" | "waiting"; done: boolean; doneAt?: number; summary?: string }
    >
  >({});

  /** 侧栏刷新节流：一轮结束后最多补一次列表刷新，避免每个工具回合都扫盘。 */
  const sessionsRefreshTimerRef = useRef<number | null>(null);
  const scheduleSessionsRefresh = useCallback(() => {
    if (sessionsRefreshTimerRef.current !== null) return;
    sessionsRefreshTimerRef.current = window.setTimeout(() => {
      sessionsRefreshTimerRef.current = null;
      invalidateSessions();
      setSessionsVersion((version) => version + 1);
    }, 1_200);
  }, []);

  /** 镜像每个标签的实时活动，用来判断"忙 → 空闲"这一跳。 */
  const liveActivityRef = useRef<Record<string, "idle" | "running" | "waiting">>({});

  const reportTabActivity = useCallback(
    (key: string, activity: "idle" | "running" | "waiting", summary?: string) => {
      const previousLive = liveActivityRef.current[key];
      liveActivityRef.current[key] = activity;
      const busyNow = activity === "running" || activity === "waiting";
      // 忙 → 空闲 = 这一轮真的跑完了：侧栏的消息数/时间/自动标题都变了，补一次刷新。
      if (!busyNow && (previousLive === "running" || previousLive === "waiting")) {
        scheduleSessionsRefresh();
      }
      setTabActivity((previous) => {
        const current = previous[key];
        const busy = activity === "running" || activity === "waiting";
        // 从忙 → 空闲，且当时不是前台标签 → 记为「后台已完成未读」
        const finishedForeground = current && (current.live === "running" || current.live === "waiting");
        const done = busy
          ? false
          : finishedForeground
            ? activeKeyRef.current !== key
            : (current?.done ?? false);
        const doneAt = done ? (current?.doneAt ?? Date.now()) : undefined;
        const nextSummary = done ? summary : undefined;
        if (
          current &&
          current.live === activity &&
          current.done === done &&
          current.summary === nextSummary
        ) {
          return previous;
        }
        return { ...previous, [key]: { live: activity, done, doneAt, summary: nextSummary } };
      });
    },
    [scheduleSessionsRefresh],
  );

  /** 已读：清掉完成状态（切到该标签 / 点「已读」/ 卡片自动淡出后都走这里）。 */
  const markTabRead = useCallback((key: string) => {
    setTabActivity((previous) => {
      const current = previous[key];
      if (!current?.done) return previous;
      return { ...previous, [key]: { ...current, done: false, doneAt: undefined, summary: undefined } };
    });
  }, []);

  const paneActionsRef = useRef({
    setDraftForTab,
    handleSessionCreated,
    handleNewSession,
    reportActivity: reportTabActivity,
  });
  useEffect(() => {
    paneActionsRef.current = {
      setDraftForTab,
      handleSessionCreated,
      handleNewSession,
      reportActivity: reportTabActivity,
    };
  }, [setDraftForTab, handleSessionCreated, handleNewSession, reportTabActivity]);

  /**
   * Per-tab handler cache. Handlers must keep a STABLE identity for the whole
   * lifetime of a tab: `ChatPane` is memoized, and a new callback would force
   * every already-mounted pane to re-render its full transcript（打开/切换会话
   * 时的主要卡顿源）。So we build each tab's handlers once and only swap the
   * implementation they call through `paneActionsRef`.
   */
  const paneHandlersCache = useRef(new Map<string, PaneHandlers>());
  const paneHandlers = useMemo(() => {
    const map = new Map<string, PaneHandlers>();
    const cache = paneHandlersCache.current;
    for (const tab of tabs) {
      let handlers = cache.get(tab.key);
      if (!handlers) {
        const key = tab.key;
        handlers = {
          onDraftChange: (value) => paneActionsRef.current.setDraftForTab(key, value),
          onSessionCreated: (session) => paneActionsRef.current.handleSessionCreated(key, session),
          onNewSession: () => {
            const current = tabsRef.current.find((item) => item.key === key);
            const targetCwd = current?.session?.cwd ?? current?.newSessionCwd ?? undefined;
            void paneActionsRef.current.handleNewSession(targetCwd);
          },
          onActivityChange: (activity, summary) =>
            paneActionsRef.current.reportActivity(key, activity, summary),
        };
        cache.set(key, handlers);
      }
      map.set(tab.key, handlers);
    }
    // 关闭的标签别再占缓存
    for (const key of cache.keys()) {
      if (!map.has(key)) cache.delete(key);
    }
    return map;
  }, [tabs]);

  /** 标签页里打开的会话 id：传给左栏，用来标出"哪些会话是打开的"。 */
  const openSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tab of tabs) if (tab.session?.id) ids.add(tab.session.id);
    return ids;
  }, [tabs]);

  // 后台完成的任务：提示条的数据源（顺序沿用标签顺序，时间用于排序/自动淡出）
  /**
   * 子 Agent 完成卡片：与对话标签的完成卡片共用同一个栈（最多 3 张）。
   * key = `agent:<kind>:<id>`，目标任务存在 ref 里（卡片只需要展示，不需要 sessionId）。
   */
  const [agentDone, setAgentDone] = useState<DoneTaskItem[]>([]);
  const agentDoneTargets = useRef(new Map<string, string>());

  const handleAgentDone = useCallback((event: AgentRailDoneEvent) => {
    const key = `agent:${event.id}`;
    agentDoneTargets.current.set(key, event.parentSessionId);
    const entry = getSessionTitleEntry(event.parentSessionId);
    const project = projectNameOf(event.cwd || entry?.cwd);
    const sessionLabel = entry?.title?.trim() || "会话";
    const title = `${project} › ${sessionLabel} · ${event.name}`;
    const summary = event.unverified
      ? "已完成（无测试证据：未验证）"
      : event.status === "failed" || event.status === "crashed"
        ? "执行失败，点开看原因"
        : "已完成，点开切换到该对话";
    setAgentDone((current) => {
      const rest = current.filter((item) => item.key !== key);
      return [...rest, { key, title, doneAt: Date.now(), summary }].slice(-6);
    });
  }, []);

  /** 按 sessionId 打开（已在标签里就直接激活，否则按 id 取一次元数据再开）。 */
  const openSessionById = useCallback(
    (sessionId: string) => {
      const existing = tabsRef.current.find((tab) => tab.session?.id === sessionId);
      if (existing) {
        activateTab(existing.key);
        return;
      }
      void (async () => {
        try {
          const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
          if (!res.ok) return;
          const data = (await res.json()) as { info?: SessionInfo | null };
          if (data.info) handleSelect(data.info);
        } catch {
          /* 打不开就算了：不弹错误，别打断当前对话 */
        }
      })();
    },
    [activateTab, handleSelect],
  );

  /** 点完成卡片：agent 卡片切到派生会话，普通卡片切标签。 */
  const handleDoneOpen = useCallback(
    (key: string) => {
      const sessionId = agentDoneTargets.current.get(key);
      if (!sessionId) {
        activateTab(key);
        return;
      }
      agentDoneTargets.current.delete(key);
      setAgentDone((current) => current.filter((item) => item.key !== key));
      openSessionById(sessionId);
    },
    [activateTab, openSessionById],
  );

  const handleDoneRead = useCallback(
    (key: string) => {
      if (agentDoneTargets.current.has(key)) {
        agentDoneTargets.current.delete(key);
        setAgentDone((current) => current.filter((item) => item.key !== key));
        return;
      }
      markTabRead(key);
    },
    [markTabRead],
  );

  const doneTasks = useMemo<DoneTaskItem[]>(() => {
    const list: DoneTaskItem[] = [...agentDone];
    for (const tab of tabs) {
      const activity = tabActivity[tab.key];
      if (!activity?.done) continue;
      list.push({
        key: tab.key,
        title: tab.title,
        doneAt: activity.doneAt ?? 0,
        summary: activity.summary,
      });
    }
    return list;
  }, [tabs, tabActivity, agentDone]);

  // 唯一的活动视图：activeKey 失效时退回到第一个标签
  const visibleKey = useMemo(() => {
    if (activeKey && tabs.some((tab) => tab.key === activeKey)) return activeKey;
    return tabs[0]?.key ?? null;
  }, [activeKey, tabs]);

  const compact = viewportWidth <= COMPACT_BREAKPOINT;
  /** 浮层里的右栏宽度：至少 COMPACT_PANEL_MIN_WIDTH，但不超过视口。 */
  const compactRightPanelWidth = Math.min(
    Math.max(rightPanelWidth, COMPACT_PANEL_MIN_WIDTH),
    Math.max(viewportWidth, 1),
  );

  return (
    <div className="app-shell-height flex w-full flex-col overflow-hidden bg-white">
      <TitleBar />

      <div className="relative flex min-h-0 flex-1">
        <div
          className={
            compact
              ? `absolute inset-y-0 left-0 z-30 flex h-full w-[260px] flex-col bg-white shadow-[0_0_24px_rgba(15,23,42,0.18)] transition-transform duration-200 ease-out ${
                  leftSidebarOpen ? "translate-x-0" : "pointer-events-none -translate-x-full"
                }`
              : `shrink-0 overflow-hidden transition-[width] duration-300 ${
                  leftSidebarOpen ? "w-[260px]" : "w-0"
                }`
          }
          aria-hidden={!leftSidebarOpen}
        >
          <div className="flex h-full w-[260px] flex-col overflow-hidden border-r border-black/[0.06] bg-white">
          <div className="flex min-h-0 flex-1 flex-col">
          <SessionSidebar
            selectedSessionId={activeTab?.session?.id ?? null}
            onSelectSession={handleSelect}
            onNewSession={(_sessionId, targetCwd) => {
              void handleNewSession(targetCwd);
            }}
            refreshKey={sessionsVersion}
            openSessionIds={openSessionIds}
            onSessionDeleted={handleSessionDeleted}
            onExportSession={(session) => setExportSessionId(session.id)}
            selectedCwd={activeCwd}
            onCwdChange={(nextCwd) => {
              setCwd(nextCwd);
              // A not-yet-created tab follows the project the user picked.
              const key = activeKeyRef.current;
              if (!key) return;
              commitTabs(
                tabsRef.current.map((tab) =>
                  tab.key === key && !tab.session
                    ? { ...tab, newSessionCwd: nextCwd, draftKey: draftKeyFor(null, nextCwd) }
                    : tab,
                ),
              );
            }}
            onOpenFile={(filePath, fileName) => handleOpenFile(filePath, fileName)}
            onCollapse={() => setLeftSidebarOpen(false)}
            onOpenProjectWindow={() => { void handleAddProject(); }}
            onAtMention={(relativePath) => {
              const key = activeKeyRef.current;
              if (!key) return;
              const current = drafts[key] ?? "";
              setDraftForTab(key, `${current}${current && !current.endsWith(" ") ? " " : ""}@${relativePath} `);
            }}
          />
          </div>
          <div className="relative shrink-0 px-2 pb-2 pt-2">
            {projectError && (
              <p role="status" className="px-1 pb-1 text-[11px] text-[#c2554e]">
                {projectError}
              </p>
            )}
            {/* 底部工具行：无托盘背景，与侧栏其它图标同一风格 */}
            <div className="flex items-center justify-evenly gap-1">
              <button
                type="button"
                onClick={() => openPanelTab("plugins")}
                title="插件"
                aria-label="插件"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-900"
              >
                <Puzzle size={16} strokeWidth={1.75} className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => openPanelTab("agents")}
                title="Agents"
                aria-label="Agents"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors duration-150 hover:bg-gray-100 hover:text-gray-900"
              >
                <Bot size={16} strokeWidth={1.75} className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                title="设置"
                aria-label="设置"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
              >
                <Settings size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setHelpOpen(true)}
                title="帮助：PiForge 功能总览"
                aria-label="帮助"
                aria-haspopup="dialog"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
              >
                <CircleHelp size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            {menuOpen && (
              <div className="material-popover absolute bottom-full left-2 right-2 z-[60] mb-1 rounded-xl p-1.5">
                {[
                  { label: "General", hint: "常规：语言、字号、热加载", action: () => setSettingsModal("general") },
                  { label: "Models", hint: "模型与登录：选择模型、登录账号", action: () => setSettingsModal("models") },
                  { label: "Auto", hint: "Auto 路由：按任务难度自动选快 / 强模型", action: () => setSettingsModal("auto") },
                  { label: "Aux", hint: "辅助模型：生图、决策、标题等轻量任务", action: () => setSettingsModal("aux") },
                  { label: "Provider", hint: "自定义 Provider：Ollama、自建网关等", action: () => setSettingsModal("providers") },
                  { label: "Plugins", hint: "插件管理：启用 / 停用扩展", action: () => setSettingsModal("plugins") },
                  { label: "Dev", hint: "开发环境与内置浏览器权限", action: () => setSettingsModal("dev") },
                  { label: "Extensions", hint: "扩展与集成总览", action: () => setSettingsModal("extensions") },
                  { label: "Skills", hint: "技能安装与管理", action: () => setSettingsModal("skills") },
                  { label: "Help", hint: "帮助：PiForge 功能总览", action: () => setHelpOpen(true) },
                ].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    title={item.hint}
                    onClick={() => {
                      setMenuOpen(false);
                      item.action();
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-muted transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
                  >
                    <span className="shrink-0">{item.label}</span>
                    <span className="min-w-0 truncate text-[10.5px] text-ink-faint">{item.hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          </div>
        </div>

        <div className="relative flex min-w-0 flex-1 flex-col">
          <SessionTabBar
            tabs={tabs.map((tab) => {
              const activity = tabActivity[tab.key];
              const status: SessionTabStatus =
                activity?.live === "waiting"
                  ? "waiting"
                  : activity?.live === "running"
                    ? "running"
                    : activity?.done
                      ? "done"
                      : "none";
              return {
                key: tab.key,
                title: tab.title,
                sessionId: tab.session?.id ?? null,
                cwd: tab.session?.cwd ?? tab.newSessionCwd,
                status,
              };
            })}
            activeKey={activeKey}
            onSelect={activateTab}
            onClose={closeTab}
            onNew={() => {
              void handleNewSession();
            }}
            leftCollapsed={!leftSidebarOpen}
            onExpandLeft={() => setLeftSidebarOpen(true)}
            rightCollapsed={!rightPanelOpen}
            onExpandRight={() => setRightPanelOpen(true)}
          />

          <div className="relative flex min-h-0 min-w-0 flex-1">
            {/* Every open tab stays mounted: streaming, scroll position and
                draft survive switching. Inactive panes are just hidden.
                `visibleKey` 兜底：activeKey 指向已关闭/未知标签时，至少显示第一个，
                绝不让「一个都不显示」或「两个都显示」的情况出现。 */}
            {tabs.map((tab) => {
              const handlers = paneHandlers.get(tab.key);
              const visible = tab.key === visibleKey;
              if (!handlers) return null;
              return (
                <div
                  key={tab.key}
                  aria-hidden={!visible}
                  className={visible ? "flex min-h-0 min-w-0 flex-1" : "hidden"}
                >
                  <ChatPane
                    session={tab.session}
                    newSessionCwd={tab.newSessionCwd}
                    draft={drafts[tab.key] ?? ""}
                    active={tab.key === activeKey}
                    modelsRefreshKey={modelsVersion}
                    onDraftChange={handlers.onDraftChange}
                    onSessionCreated={handlers.onSessionCreated}
                    onSessionRenamed={handleSessionRenamed}
                    onNewSession={handlers.onNewSession}
                    onActivityChange={handlers.onActivityChange}
                    onInsertCode={handleInsertCode}
                    applyTargetName={openFile && !openFile.diff ? openFile.fileName : null}
                    onApplyCode={handleApplyCode}
                    onOpenGitDiff={handleOpenGitDiff}
                    onOpenFile={handleOpenChatFile}
                    onSessionForked={handleSessionForked}
                  />
                </div>
              );
            })}

          </div>
        </div>

        {compact && (leftSidebarOpen || rightPanelOpen) && (
          <div
            role="presentation"
            onClick={() => {
              setLeftSidebarOpen(false);
              setRightPanelOpen(false);
            }}
            className="absolute inset-0 z-20 bg-slate-900/10"
            aria-hidden="true"
          />
        )}

        <div
          className={
            compact
              ? `absolute inset-y-0 right-0 z-30 h-full bg-white shadow-[0_0_24px_rgba(15,23,42,0.18)] transition-transform duration-200 ease-out ${
                  rightPanelOpen ? "translate-x-0" : "pointer-events-none translate-x-full"
                }`
              : `relative shrink-0 overflow-hidden ${
                  rightPanelResizing
                    ? ""
                    : "transition-[width] duration-200 ease-in-out"
                } ${rightPanelOpen ? "" : "pointer-events-none"}`
          }
          style={{
            width: compact
              ? compactRightPanelWidth
              : rightPanelOpen
                ? rightPanelWidth
                : 0,
          }}
          aria-hidden={!rightPanelOpen}
        >
          {rightPanelOpen && !compact && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整右侧面板宽度"
              title="拖动调整右侧面板宽度"
              onPointerDown={startRightPanelResize}
              onPointerMove={moveRightPanelResize}
              onPointerUp={endRightPanelResize}
              onPointerCancel={endRightPanelResize}
              className="absolute inset-y-0 left-0 z-30 w-1 touch-none cursor-col-resize bg-transparent transition-colors hover:bg-[#D9E5FB] active:bg-accent/30"
              style={{ touchAction: "none" }}
            />
          )}
          {/* 内部固定宽度：折叠/展开只裁剪外层，内容不逐帧重排 → 过渡流畅。 */}
          <div
            className="h-full"
            style={{ width: compact ? compactRightPanelWidth : rightPanelWidth }}
          >
            <FilePanel
              cwd={activeCwd}
              sessionId={activeTab?.session?.id ?? null}
              explorerRefreshKey={explorerRefreshKey}
              viewerRefreshKey={fileViewerRefreshKey}
              openFile={openFile}
              gitOpenSignal={gitTabSignal}
              onOpenFile={handleOpenFile}
              onOpenDiff={handleOpenDiff}
              onCloseFile={handleCloseFile}
              onCollapse={() => setRightPanelOpen(false)}
              onOpenSession={openSessionById}
              onAgentDone={handleAgentDone}
            />
          </div>
        </div>
      </div>

      <TaskDoneToasts items={doneTasks} onOpen={handleDoneOpen} onRead={handleDoneRead} />

      {settingsModal === "general" && (
        <GeneralSettingsModal
          sessionId={activeTab?.session?.id ?? null}
          cwd={activeCwd ?? null}
          onClose={() => setSettingsModal(null)}
        />
      )}
      {settingsModal === "skills" && (
        <SkillsConfig cwd={activeCwd ?? ""} onClose={() => setSettingsModal(null)} />
      )}
      {settingsModal === "mcp" && (
        <McpSettingsModal cwd={activeCwd ?? ""} onClose={() => setSettingsModal(null)} />
      )}
      {settingsModal === "auto" && (
        <AutoRoutingConfig
          onClose={() => {
            setSettingsModal(null);
            setModelsVersion((version) => version + 1);
          }}
        />
      )}
      {settingsModal === "aux" && (
        <AuxModelsConfig onClose={() => setSettingsModal(null)} />
      )}
      {settingsModal === "dev" && (
        <DevEnvironmentConfig onClose={() => setSettingsModal(null)} />
      )}
      {settingsModal === "providers" && (
        <CustomProvidersConfig
          onClose={() => {
            setSettingsModal(null);
            setModelsVersion((version) => version + 1);
          }}
        />
      )}
      {settingsModal === "plugins" && (
        <PluginsConfig onClose={() => setSettingsModal(null)} />
      )}
      {applyRequest && (
        <ApplyCodeModal
          target={applyRequest.target}
          code={applyRequest.code}
          language={applyRequest.language}
          cwd={activeCwd}
          onClose={() => setApplyRequest(null)}
          onApplied={() => {
            setExplorerRefreshKey((key) => key + 1);
            setFileViewerRefreshKey((key) => key + 1);
          }}
        />
      )}
      {settingsModal === "extensions" && (
        <ExtensionsConfigModal
          isOpen
          cwd={cwd ?? undefined}
          initialTab="extensions"
          onClose={() => setSettingsModal(null)}
        />
      )}
      {settingsModal === "models" && (
        <ModelsConfig
          onClose={() => {
            setSettingsModal(null);
            setModelsVersion((version) => version + 1);
          }}
        />
      )}
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />

      <SessionExportModal
        isOpen={exportSessionId !== null}
        onClose={() => setExportSessionId(null)}
        sessionId={exportSessionId}
      />
    </div>
  );
}

export default Workbench;
