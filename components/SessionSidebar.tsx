"use client";

import { useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { SidebarHeader } from "./session-sidebar/SidebarHeader";
import { SessionTreeItem } from "./session-sidebar/SessionTree";
import { ProjectGroup } from "./session-sidebar/ProjectGroup";
import { SidebarIcon } from "./session-sidebar/SidebarIcon";
import { groupProjects, partitionProjects, projectExpanded, projectKey, recentProjectKeys, searchProjects, sortProjects, type SidebarProject } from "./session-sidebar/projects";
import { groupSessionNodesByDate } from "./session-sidebar/date-groups";
import { dateGroupContainsSession, dateGroupOpen, dateGroupStateKey, previewSessionGroups, SESSION_PREVIEW_LIMIT } from "./session-sidebar/session-preview";
import { SortableProjects } from "./session-sidebar/SortableProjects";
import { useSidebarPreferences } from "./session-sidebar/useSidebarPreferences";
import { useI18n } from "./I18nProvider";
import { fetchSessionPage, fetchSessionsUpTo, invalidateSessions, SESSION_PAGE_SIZE, SESSION_PAGE_STEP } from "@/lib/sessions-cache";
import { mergeSessionList } from "./session-sidebar/session-merge";
import { rememberSessionTitles } from "@/lib/session-titles";
import { scheduleIdleTask } from "@/lib/idle-task";
import { ErrorNotice } from "./ErrorNotice";
import { SidebarErrorBoundary } from "./session-sidebar/SidebarErrorBoundary";

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  /** 已在标签页打开的会话 id（左栏据此标出"哪些是打开的"）。 */
  openSessionIds?: ReadonlySet<string>;
  onSessionDeleted?: (sessionId: string) => void;
  onBranchSession?: (session: SessionInfo) => void;
  onCloneSession?: (session: SessionInfo) => void;
  onExportSession?: (session: SessionInfo) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  explorerRefreshKey?: number;
  onAtMention?: (relativePath: string) => void;
  onOpenProjectWindow?: () => void;
  onCollapse?: () => void;
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, onInitialRestoreDone, refreshKey, openSessionIds, onSessionDeleted, onBranchSession, onCloneSession, onExportSession, selectedCwd: selectedCwdProp, onCwdChange, onCollapse, onOpenProjectWindow }: Props) {
  const { t, locale } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  /** loadSessions 里读"当前列表是否为空"，用 ref 免掉多余的依赖重建。 */
  const allSessionsRef = useRef<SessionInfo[]>([]);
  allSessionsRef.current = allSessions;
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const loadingMoreRef = useRef(false);
  /** 当前列表已经加载到多深（刷新时按这个深度重取，避免列表缩短）。 */
  const loadedDepthRef = useRef(0);
  /** 服务端给的分页游标：首页多了「每项目最新一条」，不能用列表长度当 offset。 */
  const nextOffsetRef = useRef(0);
  const hasMoreRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [animateProjectSorting, setAnimateProjectSorting] = useState(true);
  const [preferences, setPreferences] = useSidebarPreferences();
  const selectedCwd = selectedCwdProp ?? null;
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectListRef = useRef<HTMLElement>(null);
  const pendingProjectRef = useRef<string | null>(null);
  const scrolledSessionRef = useRef<string | null>(null);
  /** 点过「显示全部」的项目：默认每个项目只露最近 SESSION_PREVIEW_LIMIT 条会话。 */
  const [expandedSessionProjects, setExpandedSessionProjects] = useState<Record<string, boolean>>({});
  /** 日期分组的展开状态，缺省只展开最新一组（今天以外的组收起来）。 */
  const [openDateGroups, setOpenDateGroups] = useState<Record<string, boolean>>({});

  const loadSessions = useCallback(async (showLoading = false, force = false) => {
    // 只有首屏（列表还是空的）才切到"加载中"占位：刷新时把已有列表整块卸载
    // 再挂回来，就是肉眼可见的"左侧一直在刷新"。
    const blank = showLoading && allSessionsRef.current.length === 0;
    try {
      if (blank) setLoading(true);
      const page = await fetchSessionPage(0, SESSION_PAGE_SIZE, { force });
      // 刷新不能把已经滚动加载出来的历史缩回第一页：否则只存在于第 2 页之后
      // 的项目分组会「消失 → 又出现」，看起来就是侧栏在跳。
      let sessions = page.sessions;
      let hasMore = page.hasMore;
      let cursor = page.nextOffset ?? page.sessions.length;
      const depth = loadedDepthRef.current;
      if (depth > sessions.length) {
        const deep = await fetchSessionsUpTo(depth);
        if (deep && deep.sessions.length > sessions.length) {
          sessions = deep.sessions;
          hasMore = deep.hasMore;
          cursor = deep.nextOffset ?? deep.sessions.length;
        }
      }
      loadedDepthRef.current = sessions.length;
      nextOffsetRef.current = cursor;
      hasMoreRef.current = hasMore;
      setHasMore(hasMore);
      setAllSessions((previous) => mergeSessionList(previous, sessions));
      // 右栏 Agents 用这份快照显示 `项目 › 会话标题`，避免再拉一次会话列表。
      rememberSessionTitles(sessions);
      setError(null);
      // 空闲时预取下一批（并发 1、2s 超时）：滚动到底部时数据已经在缓存里。
      if (page.hasMore) {
        scheduleIdleTask(() => {
          void fetchSessionPage(SESSION_PAGE_SIZE, SESSION_PAGE_STEP).catch(() => undefined);
        });
      }
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : t("common.failed"));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [t]);

  /**
   * 侧栏滚动到底部时按批（10 个）追加历史会话。
   * 分页请求在后台进行，不改变当前渲染内容 —— 用户滚动不会等 I/O。
   */
  const loadMoreSessions = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const offset = nextOffsetRef.current;
      const page = await fetchSessionPage(offset, SESSION_PAGE_STEP);
      nextOffsetRef.current = page.nextOffset ?? offset + SESSION_PAGE_STEP;
      hasMoreRef.current = page.hasMore;
      setHasMore(page.hasMore);
      setAllSessions((previous) => {
        // 追加时复用已有行对象，并且只在老行没出现过的位置补新行。
        const seen = new Set(previous.map((session) => session.id));
        const appended = page.sessions.filter((session) => !seen.has(session.id));
        const merged = appended.length > 0 ? [...previous, ...appended] : previous;
        loadedDepthRef.current = merged.length;
        return merged;
      });
    } catch {
      // 追加失败不影响已渲染列表；下次滚动再试。
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    void loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  const projects = useMemo(() => groupProjects(allSessions, [...preferences.paths, ...(selectedCwd ? [selectedCwd] : [])]), [allSessions, preferences.paths, selectedCwd]);
  const sortedProjects = useMemo(() => sortProjects(projects, preferences.sortMode, preferences.projectOrder, locale), [projects, preferences.sortMode, preferences.projectOrder, locale]);
  const visibleProjects = useMemo(() => searchProjects(sortedProjects, searchQuery), [sortedProjects, searchQuery]);
  const searching = !!searchQuery.trim();
  const activeProjectKey = selectedCwd ? projectKey(selectedCwd) : null;
  /** 最近活跃的 N 个项目默认展开，其余收进「其他项目」收纳盒。 */
  const recentKeys = useMemo(() => recentProjectKeys(sortedProjects), [sortedProjects]);
  const projectPartition = useMemo(() => partitionProjects(visibleProjects, {
    recentKeys, activeKey: activeProjectKey, expanded: preferences.expanded, autoCollapse: preferences.autoCollapse,
  }), [visibleProjects, recentKeys, activeProjectKey, preferences.expanded, preferences.autoCollapse]);
  const isExpanded = useCallback((key: string) => projectExpanded(key, {
    expanded: preferences.expanded, activeKey: activeProjectKey, recentKeys, searching, autoCollapse: preferences.autoCollapse,
  }), [preferences.expanded, preferences.autoCollapse, activeProjectKey, recentKeys, searching]);
  // 滚动到底部时用 IntersectionObserver 懒加载：哨兵元素进入视口才拉下一批，
  // 回调里只做一次异步请求，不参与滚动帧。
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  /**
   * 还有项目停在「只露最近 N 条」的预览态时，暂停自动追加历史：
   * 多拉回来的会话都被上限挡着不显示，只会白刷请求、把列表越拖越长。
   * 用户点「显示全部」或底部的「加载更多会话」时才继续。
   */
  const autoLoadPaused = !searching && projectPartition.main.some((project) =>
    project.tree.length > SESSION_PREVIEW_LIMIT && expandedSessionProjects[project.key] !== true);
  useEffect(() => {
    const list = projectListRef.current;
    const sentinel = loadMoreSentinelRef.current;
    if (!list || !sentinel || searching || autoLoadPaused) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMoreSessions();
      },
      { root: list, rootMargin: "160px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMoreSessions, searching, allSessions.length, autoLoadPaused]);

  /**
   * 手风琴式展开：同一时刻只留一个项目展开，切换项目自动收起上一个。
   * 必须把其余项目显式记成 false —— 只删记录不够：最近活跃的项目缺省就是展开的，
   * 删掉记录等于让它立刻弹回来。
   */
  const setExpanded = useCallback((key: string, expanded: boolean) => {
    setPreferences((previous) => {
      const next: Record<string, boolean> = {};
      if (expanded) {
        for (const other of Object.keys(previous.expanded)) if (other !== key) next[other] = false;
        next[key] = true;
      } else {
        Object.assign(next, previous.expanded);
        next[key] = false;
      }
      return { ...previous, expanded: next };
    });
  }, [setPreferences]);

  const addProject = useCallback((cwd: string) => {
    const key = projectKey(cwd);
    pendingProjectRef.current = key;
    setPreferences((previous) => ({
      ...previous,
      paths: previous.paths.some((path) => projectKey(path) === key) ? previous.paths : [...previous.paths, cwd],
    }));
    setExpanded(key, true);
  }, [setExpanded, setPreferences]);

  const newSession = useCallback((cwd: string) => {
    setSearchQuery("");
    setExpanded(projectKey(cwd), true);
    onNewSession?.("", cwd);
  }, [onNewSession, setExpanded]);

  // Reveal a restored URL or fork once; refresh must respect manual collapse.
  const revealedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedSessionId || revealedSessionRef.current === selectedSessionId) return;
    const session = allSessions.find((item) => item.id === selectedSessionId);
    if (!session) return;
    revealedSessionRef.current = selectedSessionId;
    setExpanded(projectKey(session.cwd), true);
  }, [selectedSessionId, allSessions, setExpanded]);

  const restoredRef = useRef(false);
  useEffect(() => {
    if (loading || error) return;
    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true;
      if (selectedSessionId === initialSessionId) return;
      const target = allSessions.find((session) => session.id === initialSessionId);
      if (target) {
        onSelectSession(target, true);
        return;
      }
      onInitialRestoreDone?.();
    }
    if (selectedCwd === null && projects[0]?.cwd) onCwdChange?.(projects[0].cwd);
  }, [loading, error, allSessions, projects, selectedCwd, initialSessionId, selectedSessionId, onCwdChange, onSelectSession, onInitialRestoreDone]);

  useEffect(() => {
    const list = projectListRef.current;
    if (!list) return;
    if (pendingProjectRef.current) {
      const project = [...list.querySelectorAll<HTMLElement>(".sidebar-project")]
        .find((element) => element.dataset.projectKey === pendingProjectRef.current);
      if (project) {
        project.querySelector(".sidebar-project-row")?.scrollIntoView({ block: "nearest" });
        pendingProjectRef.current = null;
      }
    }
    if (selectedSessionId && scrolledSessionRef.current !== selectedSessionId) {
      const selected = list.querySelector<HTMLElement>(".sidebar-session-row[data-selected]");
      if (selected?.getClientRects().length) {
        selected.scrollIntoView({ block: "nearest" });
        scrolledSessionRef.current = selectedSessionId;
      }
    }
  }, [projects, preferences.expanded, selectedSessionId]);

  /** 项目行渲染：常规区和「其他项目」收纳盒共用，避免两处行为分叉。 */
  const renderProject = (project: SidebarProject, dragHandle: ReactNode, dragging: boolean) => {
    const dateGroups = groupSessionNodesByDate(project.tree);
    // 选中项在这个项目里就整组铺开：被上限裁掉的会话不能连选中行一起消失。
    const expandedAll = searching || expandedSessionProjects[project.key] === true
      || dateGroupContainsSession(project.tree, selectedSessionId);
    const preview = previewSessionGroups(dateGroups, { expanded: expandedAll });
    const showAllToggle = !searching && preview.totalCount > SESSION_PREVIEW_LIMIT;
    return (
      <ProjectGroup project={project} dragHandle={dragHandle} dragging={dragging} expanded={isExpanded(project.key)} active={project.key === activeProjectKey} duplicateName={projects.some((other) => other.key !== project.key && other.name === project.name)} onToggle={(expanded) => {
        if (searching) setSearchQuery("");
        setExpanded(project.key, expanded);
      }} onNewSession={() => newSession(project.cwd)}>
        {project.sessions.length === 0 && <button className="sidebar-empty-project" onClick={() => newSession(project.cwd)}>{t("sidebar.startFirstSession")}<SidebarIcon name="plus" size={13} /></button>}
        {preview.groups.map((group, index) => {
          // 搜索、最新一组、选中项所在组一律展开；其余的看用户点没点过。
          const open = searching || index === 0
            || dateGroupContainsSession(group.nodes, selectedSessionId)
            || dateGroupOpen(openDateGroups, project.key, group.bucket, false);
          return (
            <div key={group.bucket} className="sidebar-date-group-wrap">
              <button type="button" className="sidebar-date-group sidebar-date-group-toggle" aria-expanded={open} onClick={() => setOpenDateGroups((previous) => ({ ...previous, [dateGroupStateKey(project.key, group.bucket)]: !open }))}>
                <SidebarIcon name="chevron" size={9} className="sidebar-project-chevron" style={{ transform: open ? "rotate(90deg)" : undefined }} />
                <span>{t(`sidebar.date.${group.bucket}`)}</span>
                <span className="sidebar-date-group-count">{group.nodes.length}</span>
              </button>
              {open && group.nodes.map((node) => <SessionTreeItem key={node.session.id} node={node} selectedSessionId={selectedSessionId} onSelectSession={onSelectSession} onRenamed={() => {
                    invalidateSessions();
                    void loadSessions(false, true);
                  }} onSessionDeleted={(id) => {
                    onSessionDeleted?.(id);
                    invalidateSessions();
                    void loadSessions(false, true);
                  }} onBranchSession={onBranchSession} onCloneSession={onCloneSession} onExportSession={onExportSession} depth={0} searching={searching} openSessionIds={openSessionIds} />)}
            </div>
          );
        })}
        {showAllToggle && <button type="button" className="sidebar-empty-project sidebar-show-more" onClick={() => setExpandedSessionProjects((previous) => ({ ...previous, [project.key]: !expandedAll }))}>
          <span>{expandedAll ? t("sidebar.showFewerSessions") : t("sidebar.showAllSessions", { count: preview.totalCount })}</span>
          <SidebarIcon name="chevron" size={11} style={{ transform: expandedAll ? "rotate(-90deg)" : "rotate(90deg)" }} />
        </button>}
      </ProjectGroup>
    );
  };

  useEffect(() => () => {
    if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
  }, []);

  return (
    <div className="sidebar-workspace">
      <SidebarHeader selectedCwd={selectedCwd ?? projects[0]?.cwd ?? null} onNewSession={newSession} onAddProject={addProject} onOpenProjectWindow={onOpenProjectWindow} loadSessions={loadSessions} sessionRefreshDone={sessionRefreshDone} searchQuery={searchQuery} onSearchQueryChange={setSearchQuery} sortMode={preferences.sortMode} onCollapse={onCollapse} onSortModeChange={(sortMode, animate) => {
        setAnimateProjectSorting(animate);
        setPreferences((previous) => ({ ...previous, sortMode }));
      }} />
      <nav ref={projectListRef} className="sidebar-project-list scrollbar-none" aria-label={t("sidebar.projects")} aria-busy={loading}>
        {loading && <div className="sidebar-empty" role="status">{t("common.loading")}</div>}
        {/* 刷新失败只提示、不清空已有项目；带一键重试 */}
        {error && (
          <div className="sidebar-empty text-danger" role="status">
            <ErrorNotice message={error} fallback="正在等待本地引擎就绪…" />
            <button
              type="button"
              onClick={() => {
                invalidateSessions();
                void loadSessions(true, true);
              }}
              className="mt-1 rounded-md border border-border px-2 py-1 text-[11px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
            >
              重试
            </button>
          </div>
        )}
        {!loading && visibleProjects.length === 0 && <div className="sidebar-empty" role="status">{t(searching ? "sidebar.noSearchResults" : "sidebar.noProjects")}</div>}
        <SidebarErrorBoundary onRetry={() => void loadSessions()}>
        <SortableProjects projects={projectPartition.main} disabled={searching || loading} animateChanges={animateProjectSorting && !searching} listRef={projectListRef} onReorder={(order) => {
          // 收纳盒里的项目不参与拖拽，排完接回末尾，避免手动排序丢掉它们的键。
          const asideKeys = projectPartition.aside.map((project) => project.key);
          setPreferences((previous) => ({ ...previous, sortMode: "manual", projectOrder: [...order, ...asideKeys] }));
        }} renderProject={renderProject} />
        {projectPartition.aside.length > 0 && (
          <div className="sidebar-project-aside">
            <button
              type="button"
              className="sidebar-date-group sidebar-aside-toggle"
              aria-expanded={preferences.projectAsideOpen}
              onClick={() => setPreferences((previous) => ({ ...previous, projectAsideOpen: !previous.projectAsideOpen }))}
            >
              <SidebarIcon name="chevron" size={10} className="sidebar-project-chevron" style={{ transform: preferences.projectAsideOpen ? "rotate(90deg)" : undefined }} />
              <span>{t("sidebar.otherProjects")}</span>
              <span className="sidebar-project-count">{projectPartition.aside.length}</span>
            </button>
            {preferences.projectAsideOpen && projectPartition.aside.map((project) => (
              <div key={project.key} className="sidebar-project-aside-item">{renderProject(project, null, false)}</div>
            ))}
          </div>
        )}
        </SidebarErrorBoundary>
        {hasMore && !searching && !loading && (
          <button
            type="button"
            onClick={() => void loadMoreSessions()}
            disabled={loadingMore}
            className="sidebar-empty-project"
            aria-label={t("sidebar.loadMore")}
          >
            {loadingMore ? t("common.loading") : t("sidebar.loadMore")}
          </button>
        )}
        {/* IntersectionObserver 哨兵：进入视口就拉下一批 */}
        <div ref={loadMoreSentinelRef} aria-hidden className="h-px w-full" />
      </nav>
    </div>
  );
}
