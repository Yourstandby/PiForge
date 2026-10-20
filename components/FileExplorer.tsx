"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { AtSign, ChevronRight, Loader2 } from "lucide-react";
import { FILE_DRAG_MIME } from "@/lib/file-drag";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { encodeFilePathForApi, getRelativeFilePath, joinFilePath } from "@/lib/file-paths";
import { useI18n } from "./I18nProvider";

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onOpenDiff?: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string) => void;
}

interface GitMark {
  status: string;
  index: string;
  worktree: string;
}

type GitStatusMap = Record<string, GitMark>;

function changedMark(status: string): { label: string; color: string; title: string } {
  const code = status.replace(/\s+/g, "");
  if (code === "??") {
    return { label: "U", color: "#2563EB", title: "未跟踪文件" };
  }
  if (code.startsWith("A")) {
    return { label: "A", color: "#3E8A63", title: "新增文件" };
  }
  if (code.startsWith("D")) {
    return { label: "D", color: "#C2554E", title: "已删除" };
  }
  if (code.startsWith("R")) {
    return { label: "R", color: "#7C5BD6", title: "已重命名" };
  }
  if (code.startsWith("U") || code === "AA" || code === "DD") {
    return { label: "!", color: "#C2554E", title: "冲突" };
  }
  return { label: "M", color: "#B7791F", title: "已修改" };
}

async function fetchEntries(dirPath: string): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) {
    // Surface the real reason (e.g. path not allowed) instead of rendering an
    // empty tree that looks like "this folder has no files".
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `读取目录失败（HTTP ${res.status}）`);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onOpenDiff,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshKey,
  gitStatus,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onOpenDiff?: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshKey?: number;
  gitStatus: GitStatusMap;
}) {
  const { t } = useI18n();
  const open = expandedPaths.has(node.fullPath);
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const relativePath = getRelativeFilePath(node.fullPath, cwd);
  const directMark = !node.isDir ? gitStatus[relativePath] : undefined;
  const dirDirty = node.isDir
    ? Object.keys(gitStatus).some((changed) => changed.startsWith(relativePath + "/"))
    : false;
  const mark = directMark ? changedMark(directMark.status) : null;

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath]);

  // When refreshKey causes a re-render with the same node identity, reload open dirs
  const prevLoadedRef = useRef(loaded);
  useEffect(() => {
    prevLoadedRef.current = loaded;
  });

  // Re-fetch children when refreshKey changes and the directory is already open/loaded
  useEffect(() => {
    if (open && loaded) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onToggleExpanded]);

  return (
    <div>
      <div
        onClick={handleClick}
        draggable={!node.isDir}
        onDragStart={(event) => {
          if (node.isDir) return;
          event.dataTransfer.setData(FILE_DRAG_MIME, node.fullPath);
          event.dataTransfer.setData("text/plain", `@${getRelativeFilePath(node.fullPath, cwd)}`);
          event.dataTransfer.effectAllowed = "copy";
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: 8,
          height: 26,
          cursor: "pointer",
          background: hovered ? "var(--bg-hover)" : "transparent",
          borderRadius: "var(--radius-control)",
          userSelect: "none",
        }}
      >
        {node.isDir && (
          <ChevronRight
            size={12}
            strokeWidth={1.75}
            style={{
              flexShrink: 0,
              color: "var(--text-dim)",
              transform: open ? "rotate(90deg)" : "none",
              transition: "transform 0.12s",
            }}
          />
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span
          style={{
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            fontWeight: mark ? 600 : 400,
          }}
          title={node.fullPath}
        >
          {node.name}
        </span>
        {mark && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDiff?.(node.fullPath, node.name);
            }}
            title={`${mark.title} · 点击查看 Git Diff`}
            aria-label={`查看 ${node.name} 的 Git Diff`}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 16,
              height: 16,
              padding: 0,
              border: "none",
              borderRadius: 4,
              background: "transparent",
              color: mark.color,
              cursor: "pointer",
              fontSize: 10,
              fontWeight: 700,
            }}
          >
            {mark.label}
          </button>
        )}
        {!mark && dirDirty && (
          <span
            title="目录内有改动"
            style={{ flexShrink: 0, width: 6, height: 6, borderRadius: 999, background: "#B7791F", marginRight: 2 }}
          />
        )}
        {loading && <Loader2 size={11} strokeWidth={1.75} className="animate-spin" style={{ color: "var(--text-dim)" }} />}
        {onAtMention && hovered && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd));
            }}
            title={t("file.insertPath")}
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: 20,
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0,
              whiteSpace: "nowrap",
            }}
          >
            <AtSign size={11} strokeWidth={2} />
            mention
          </button>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode key={child.fullPath} node={child} depth={depth + 1} cwd={cwd} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} onAtMention={onAtMention} expandedPaths={expandedPaths} onToggleExpanded={onToggleExpanded} refreshKey={refreshKey} gitStatus={gitStatus} />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ cwd, onOpenFile, onOpenDiff, refreshKey, onAtMention }: Props) {
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [gitStatus, setGitStatus] = useState<GitStatusMap>({});
  const prevCwdRef = useRef<string | null>(null);

  // Git status poll: cheap (one `git status`), keeps markers live while the
  // agent edits files in the background. Failures (non-repo, git missing)
  // silently clear the markers.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)
        .then((res) => res.json())
        .then((data: { files?: Array<{ path: string; status: string; index: string; worktree: string }> }) => {
          if (cancelled) return;
          const next: GitStatusMap = {};
          for (const file of data.files ?? []) next[file.path] = file;
          setGitStatus(next);
        })
        .catch(() => {
          if (!cancelled) setGitStatus({});
        });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cwd, refreshKey]);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) setExpandedPaths(new Set());

    setLoading(cwdChanged);
    setError(null);
    fetchEntries(cwd)
      .then((entries) => setRoots(entries))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [cwd, refreshKey]);

  if (loading) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
        Loading files...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--danger)" }}>
        {error}
      </div>
    );
  }

  return (
    <div style={{ padding: "2px 4px" }}>
      {roots.map((node) => (
        <TreeNode
          key={node.fullPath}
          node={node}
          depth={0}
          cwd={cwd}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          onAtMention={onAtMention}
          expandedPaths={expandedPaths}
          onToggleExpanded={handleToggleExpanded}
          refreshKey={refreshKey}
          gitStatus={gitStatus}
        />
      ))}
      {roots.length === 0 && (
        <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
          No files found
        </div>
      )}
    </div>
  );
}
