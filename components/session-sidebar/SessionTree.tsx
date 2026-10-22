"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo } from "@/lib/types";
import { formatRelativeTime, type SessionTreeNode } from "./helpers";
import { sessionTitle } from "./projects";
import { SidebarIcon } from "./SidebarIcon";
import { useI18n } from "../I18nProvider";
import { apiJson } from "../apiJson";
import { useDismissOnOutsideClick } from "@/hooks/useDismissOnOutsideClick";

interface SessionTreeItemProps {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  onBranchSession?: (session: SessionInfo) => void;
  onCloneSession?: (session: SessionInfo) => void;
  onExportSession?: (session: SessionInfo) => void;
  depth: number;
  searching?: boolean;
  /** 已经在标签页里打开的会话 id：左栏要给个标记，否则分不清"打开过"和"没打开"。 */
  openSessionIds?: ReadonlySet<string>;
}

function containsSession(nodes: SessionTreeNode[], id: string | null): boolean {
  return nodes.some((node) => node.session.id === id || containsSession(node.children, id));
}

export function SessionTreeItem(props: SessionTreeItemProps) {
  const { node, selectedSessionId, depth, searching } = props;
  const [collapsed, setCollapsed] = useState(false);
  const containsSelection = containsSession(node.children, selectedSessionId);
  useEffect(() => {
    if (containsSelection || searching) setCollapsed(false);
  }, [selectedSessionId, containsSelection, searching]);
  const expanded = !collapsed;

  return (
    <div className="sidebar-session-node">
      <SessionItem {...props} collapsed={!expanded} onToggleCollapse={() => setCollapsed(expanded)} />
      {node.children.length > 0 && <div className="session-tree-children" hidden={!expanded}>
        {node.children.map((child) => <SessionTreeItem {...props} key={child.session.id} node={child} depth={depth + 1} />)}
      </div>}
    </div>
  );
}

function SessionItem({
  node, selectedSessionId, onSelectSession, onRenamed, onSessionDeleted,
  onBranchSession, onCloneSession, onExportSession, depth, collapsed, onToggleCollapse,
  openSessionIds,
}: SessionTreeItemProps & { collapsed: boolean; onToggleCollapse: () => void }) {
  const session = node.session;
  const isSelected = session.id === selectedSessionId;
  const isOpen = openSessionIds?.has(session.id) ?? false;
  const { locale, t } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  /** 删除确认弹窗的固定定位坐标（portal + fixed，绝不参与列表排版）。 */
  const [confirmPos, setConfirmPos] = useState<{ x: number; y: number } | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const confirmDelete = confirmPos !== null;
  const inputRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRenameRef = useRef(false);
  const title = sessionTitle(session);
  const menuOpen = menuPos !== null;

  useEffect(() => {
    if (renaming) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [renaming]);
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menuOpen]);
  useDismissOnOutsideClick(menuRef, menuOpen, (reason) => {
    setMenuPos(null);
    if (reason === "escape") triggerRef.current?.focus();
  });
  // 删除确认弹窗：点取消 / 点空白 / Esc 都立刻关闭（允许点击触发按钮本身算"内部"）
  useDismissOnOutsideClick([confirmRef, triggerRef], confirmDelete, (reason) => {
    closeDeleteConfirm(reason === "escape");
  });

  const commitRename = useCallback(async () => {
    setRenaming(false);
    if (cancelRenameRef.current) return;
    const name = renameValue.trim();
    if (name === (session.name ?? "")) return;
    try {
      await apiJson("/api/sessions/" + encodeURIComponent(session.id), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      }, { fallback: t("common.failed") });
      onRenamed?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("common.failed"));
    }
  }, [renameValue, session.id, session.name, onRenamed, t]);

  const deleteSession = async () => {
    closeDeleteConfirm();
    setDeleting(true);
    try {
      await apiJson("/api/sessions/" + encodeURIComponent(session.id), { method: "DELETE" }, { fallback: t("common.failed") });
      onSessionDeleted?.(session.id);
    } catch (error) {
      setDeleting(false);
      setActionError(error instanceof Error ? error.message : t("common.failed"));
    }
  };

  const actions = [
    ...(onBranchSession ? [{ label: t("sidebar.branchSession"), icon: "branch" as const, run: () => onBranchSession(session) }] : []),
    ...(onCloneSession ? [{ label: t("sidebar.cloneSession"), icon: "copy" as const, run: () => onCloneSession(session) }] : []),
    ...(onExportSession ? [{ label: t("sidebar.exportSession"), icon: "download" as const, run: () => onExportSession(session) }] : []),
    { label: t("sidebar.renameSession"), icon: "pencil" as const, run: () => {
      cancelRenameRef.current = false;
      setRenameValue(session.name ?? "");
      setRenaming(true);
    } },
    { label: t("sidebar.deleteAction"), icon: "trash" as const, run: () => openDeleteConfirm() },
  ];
  const openDeleteConfirm = () => {
    const rect = triggerRef.current?.getBoundingClientRect() ?? selectRef.current?.getBoundingClientRect();
    const width = 248;
    const x = rect ? Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) : 16;
    const y = rect ? Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 132)) : 80;
    setConfirmPos({ x, y });
  };

  const closeDeleteConfirm = (restoreFocus = false) => {
    setConfirmPos(null);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const openMenu = (x: number, y: number) => {
    setActionError(null);
    setMenuPos({
      x: Math.max(8, Math.min(x, window.innerWidth - 198)),
      y: Math.max(8, Math.min(y, window.innerHeight - actions.length * 34 - 18)),
    });
  };

  return (
    <>
      <div className="sidebar-session-row" data-selected={isSelected || undefined} data-open={(isOpen && !isSelected) || undefined} data-menu-open={menuOpen || undefined} data-confirming={confirmDelete || undefined} aria-busy={deleting} style={{ paddingLeft: Math.min(depth, 6) * 12 + 22 }} onContextMenu={(event) => {
        if (renaming || confirmDelete) return;
        event.preventDefault();
        openMenu(event.clientX, event.clientY);
      }}>
        {renaming ? <input ref={inputRef} aria-label={t("sidebar.renameSession")} className="sidebar-rename-input" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onBlur={() => void commitRename()} onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") { cancelRenameRef.current = true; setRenaming(false); }
        }} /> : <>
          {node.children.length > 0 ? <button className="sidebar-fork-toggle" onClick={onToggleCollapse} aria-expanded={!collapsed} aria-label={t(collapsed ? "sidebar.expandForks" : "sidebar.collapseForks")} title={t(collapsed ? "sidebar.expandForks" : "sidebar.collapseForks")}><SidebarIcon name="chevron" size={10} style={{ transform: collapsed ? undefined : "rotate(90deg)" }} /></button> : <span className="sidebar-fork-spacer" />}
          <button ref={selectRef} className="sidebar-session-select" aria-current={isSelected ? "page" : undefined} onClick={() => onSelectSession(session)} disabled={deleting} title={title + "\n" + formatRelativeTime(session.modified, locale) + " · " + t("common.messages", { count: session.messageCount })}>
            {depth > 0 && <SidebarIcon name="branch" size={11} className="sidebar-fork-icon" />}
            {isOpen && !isSelected && (
              <span
                className="sidebar-session-open-dot"
                aria-hidden="true"
                title={t("sidebar.openTab")}
              />
            )}
            <span className="sidebar-session-title">{title}</span>
            <time className="sidebar-session-time" dateTime={session.modified}>{formatRelativeTime(session.modified, locale, true)}</time>
          </button>
          <button ref={triggerRef} className="sidebar-icon-button sidebar-session-actions" aria-label={t("common.moreActions")} title={t("common.moreActions")} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(event) => {
            if (menuOpen) { setMenuPos(null); return; }
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(rect.right - 190, rect.bottom + 4);
          }}><SidebarIcon name="more" size={14} /></button>
        </>}
      </div>
      {confirmDelete && createPortal(
        <div
          ref={confirmRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("sidebar.deleteAction")}
          className="rounded-xl bg-white p-3.5 shadow-[0_18px_44px_-10px_rgba(15,23,42,0.22),0_2px_8px_rgba(15,23,42,0.06)]"
          style={{
            position: "fixed",
            top: confirmPos?.y ?? 0,
            left: confirmPos?.x ?? 0,
            width: 248,
            zIndex: 999,
          }}
        >
          <p className="text-xs leading-relaxed text-gray-600">
            {t("sidebar.deleteConfirm")}
          </p>
          <p className="mt-1 truncate text-xs text-gray-400" title={title}>
            {title}
          </p>
          <div className="mt-3 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => closeDeleteConfirm(true)}
              className="rounded-md bg-gray-100 px-3 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-200"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void deleteSession()}
              disabled={deleting}
              className="rounded-md bg-red-50 px-3 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t("common.delete")}
            </button>
          </div>
        </div>,
        document.body,
      )}
      {actionError && <p className="sidebar-action-error" role="alert">{actionError}</p>}
      {menuPos && createPortal(
        <div ref={menuRef} role="menu" aria-label={t("common.moreActions")} className="sidebar-session-menu material-popover shadow-popover t-dropdown is-open" data-origin="top-right" style={{ position: "fixed", top: menuPos.y, left: menuPos.x, zIndex: 1000 }} onKeyDown={(event) => {
          if (event.key === "Tab") { setMenuPos(null); triggerRef.current?.focus(); return; }
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
          if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
        }}>
          {actions.map((action) => <button key={action.icon} role="menuitem" tabIndex={-1} className={action.icon === "trash" ? "sidebar-menu-danger" : undefined} onClick={() => { setMenuPos(null); setActionError(null); action.run(); }}><SidebarIcon name={action.icon} size={14} />{action.label}</button>)}
        </div>, document.body
      )}
    </>
  );
}
