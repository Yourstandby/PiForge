"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../I18nProvider";
import type { SidebarProject } from "./projects";
import { SidebarIcon } from "./SidebarIcon";
import { ProjectTintDot } from "../ProjectTintDot";
import { useDismissOnOutsideClick } from "@/hooks/useDismissOnOutsideClick";

export function ProjectGroup({ project, expanded, active, duplicateName, onToggle, onNewSession, onRename, onRemove, children, dragHandle, dragging = false }: {
  project: SidebarProject;
  expanded: boolean;
  active: boolean;
  duplicateName: boolean;
  onToggle: (expanded: boolean) => void;
  onNewSession: () => void;
  /** 只改左栏显示名，目录不动。传空串表示恢复默认（文件夹名）。 */
  onRename: (name: string) => void;
  /** 从侧栏移除该项目（只隐藏显示，会话与磁盘目录都保留）。 */
  onRemove: () => void;
  children: ReactNode;
  dragHandle?: ReactNode;
  dragging?: boolean;
}) {
  const { t } = useI18n();
  const contentId = useId();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRenameRef = useRef(false);
  const menuOpen = menuPos !== null;

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);
  useDismissOnOutsideClick(menuRef, menuOpen, (reason) => {
    setMenuPos(null);
    if (reason === "escape") triggerRef.current?.focus();
  });

  const openMenu = (x: number, y: number) => {
    setMenuPos({
      x: Math.max(8, Math.min(x, window.innerWidth - 198)),
      y: Math.max(8, Math.min(y, window.innerHeight - 2 * 34 - 18)),
    });
  };

  const commitRename = () => {
    setRenaming(false);
    if (cancelRenameRef.current) return;
    onRename(renameValue);
  };

  const actions = [
    { label: t("sidebar.renameProject"), icon: "pencil" as const, run: () => {
      cancelRenameRef.current = false;
      setRenameValue(project.name);
      setRenaming(true);
    } },
    { label: t("sidebar.removeProject"), icon: "trash" as const, run: onRemove },
  ];

  return (
    <section className="sidebar-project" data-project-key={project.key} data-dragging={dragging || undefined}>
      <div
        className="sidebar-project-row"
        data-active={active || undefined}
        data-menu-open={menuOpen || undefined}
        onContextMenu={(event) => {
          if (renaming) return;
          event.preventDefault();
          openMenu(event.clientX, event.clientY);
        }}
      >
        {dragHandle}
        {renaming ? (
          <input
            ref={inputRef}
            aria-label={t("sidebar.renameProject")}
            className="sidebar-rename-input"
            style={{ flex: 1, minWidth: 0 }}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={() => commitRename()}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
              if (event.key === "Escape") { cancelRenameRef.current = true; setRenaming(false); }
            }}
          />
        ) : <>
          <button
            className="sidebar-project-toggle"
            aria-expanded={expanded}
            aria-controls={contentId}
            title={project.cwd}
            onClick={() => onToggle(!expanded)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                onToggle(event.key === "ArrowRight");
              }
            }}
          >
            <SidebarIcon name="chevron" size={10} className="sidebar-project-chevron" style={{ transform: expanded ? "rotate(90deg)" : undefined }} />
            <SidebarIcon name={expanded ? "folder-open" : "folder"} size={17} className="sidebar-project-folder" />
            {/* 与顶部标签完全一致的微胶囊 */}
            <ProjectTintDot cwd={project.cwd} className="mr-1" />
            <span className="sidebar-project-name">{project.name || t("sidebar.otherSessions")}</span>
            {duplicateName && <span className="sidebar-project-path">{project.parentPath}</span>}
          </button>
          <span className="sidebar-project-count" aria-hidden="true">{project.sessions.length || ""}</span>
          <button className="sidebar-icon-button sidebar-project-add" title={t("sidebar.newSessionIn", { path: project.cwd })} aria-label={t("sidebar.newSessionIn", { path: project.cwd })} disabled={!project.cwd} onClick={onNewSession}>
            <SidebarIcon name="plus" size={15} />
          </button>
          <button
            ref={triggerRef}
            className="sidebar-icon-button sidebar-project-more"
            aria-label={t("common.moreActions")}
            title={t("common.moreActions")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => {
              if (menuOpen) { setMenuPos(null); return; }
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu(rect.right - 190, rect.bottom + 4);
            }}
          >
            <SidebarIcon name="more" size={14} />
          </button>
        </>}
      </div>
      <div className="sidebar-project-content" id={contentId} data-expanded={expanded && !dragging} aria-hidden={!expanded || dragging} inert={!expanded || dragging}>
        <div className="sidebar-project-content-inner">{children}</div>
      </div>
      {menuPos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("common.moreActions")}
          className="sidebar-session-menu material-popover shadow-popover t-dropdown is-open"
          data-origin="top-right"
          style={{ position: "fixed", top: menuPos.y, left: menuPos.x, zIndex: 1000 }}
          onKeyDown={(event) => {
            if (event.key === "Tab") { setMenuPos(null); triggerRef.current?.focus(); }
          }}
        >
          {actions.map((action) => (
            <button
              key={action.icon}
              role="menuitem"
              tabIndex={-1}
              className={action.icon === "trash" ? "sidebar-menu-danger" : undefined}
              onClick={() => { setMenuPos(null); action.run(); }}
            >
              <SidebarIcon name={action.icon} size={14} />{action.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </section>
  );
}
