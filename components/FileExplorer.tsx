"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { isHostTransportError, visibleErrorMessage } from "@/lib/ui-error";
import { AtSign, ChevronRight, Loader2 } from "lucide-react";
import { FILE_DRAG_MIME } from "@/lib/file-drag";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { encodeFilePathForApi, getRelativeFilePath, joinFilePath } from "@/lib/file-paths";
import { computeRevealChain } from "@/lib/file-reveal";
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
  /** 聊天里的文件链接：展开祖先目录、滚动到该文件并高亮。nonce 变化即触发。 */
  reveal?: { path: string; nonce: number } | null;
}

interface GitMark {
  status: string;
  index: string;
  worktree: string;
}

type GitStatusMap = Record<string, GitMark>;

function parentDirOf(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return index > 0 ? filePath.slice(0, index) : filePath;
}

interface MenuItemSpec {
  label: string;
  run: () => void;
  danger?: boolean;
}

/** 文件树右键菜单：固定定位浮层，点空白处关闭。 */
function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItemSpec[];
  onClose: () => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (typeof window === "undefined") return;
    setViewport({ width: window.innerWidth, height: window.innerHeight });
  }, []);

  const width = 188;
  const height = items.length * 27 + 8;
  const left = Math.max(6, Math.min(x, (viewport.width || 1440) - width - 8));
  const top = Math.max(6, Math.min(y, (viewport.height || 900) - height - 8));

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 90 }}
      onMouseDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          position: "absolute",
          left,
          top,
          width,
          padding: 4,
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "0 10px 28px rgba(15, 23, 42, 0.16)",
        }}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            onMouseEnter={() => setHovered(item.label)}
            onMouseLeave={() => setHovered(null)}
            onClick={item.run}
            style={{
              display: "block",
              width: "100%",
              padding: "5px 10px",
              border: "none",
              borderRadius: 5,
              background: hovered === item.label ? "var(--bg-hover)" : "transparent",
              color: item.danger ? "var(--danger)" : "var(--text)",
              fontSize: 12,
              textAlign: "left",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 重命名 / 新建 的少量文本输入：Electron 里没有 window.prompt，只能自带弹层。 */
function FileOpPrompt({
  title,
  value,
  busy,
  error,
  onChange,
  onCancel,
  onSubmit,
}: {
  title: string;
  value: string;
  busy: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 95,
        background: "rgba(15, 23, 42, 0.18)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onMouseDown={onCancel}
    >
      <div
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: 300,
          padding: 14,
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 16px 40px rgba(15, 23, 42, 0.2)",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{title}</div>
        <input
          autoFocus
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          style={{
            width: "100%",
            height: 28,
            padding: "0 8px",
            fontSize: 12,
            color: "var(--text)",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            outline: "none",
          }}
        />
        {error && <div style={{ marginTop: 6, fontSize: 11, color: "var(--danger)" }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              height: 26,
              padding: "0 12px",
              fontSize: 12,
              color: "var(--text-secondary)",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onSubmit}
            style={{
              height: 26,
              padding: "0 12px",
              fontSize: 12,
              fontWeight: 600,
              color: "#FFFFFF",
              background: "var(--accent)",
              border: "none",
              borderRadius: 6,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "处理中…" : "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}

function changedMark(status: string): { label: string; color: string; title: string } {
  const code = status.replace(/\s+/g, "");
  if (code === "??") {
    return { label: "U", color: "var(--accent)", title: "未跟踪文件" };
  }
  if (code.startsWith("A")) {
    return { label: "A", color: "var(--success)", title: "新增文件" };
  }
  if (code.startsWith("D")) {
    return { label: "D", color: "var(--danger)", title: "已删除" };
  }
  if (code.startsWith("R")) {
    return { label: "R", color: "#7C5BD6", title: "已重命名" };
  }
  if (code.startsWith("U") || code === "AA" || code === "DD") {
    return { label: "!", color: "var(--danger)", title: "冲突" };
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
  onContextMenuNode,
  selectedPath,
  onSelectPath,
  registerRow,
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
  onContextMenuNode: (node: FileNode, x: number, y: number) => void;
  /** 当前被定位/选中的文件（聊天链接定位时高亮）。 */
  selectedPath?: string | null;
  onSelectPath?: (fullPath: string) => void;
  /** 注册行 DOM，供外部 reveal 时 scrollIntoView。 */
  registerRow?: (fullPath: string, el: HTMLDivElement | null) => void;
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
  const isSelected = !!selectedPath && selectedPath === node.fullPath;

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

  /**
   * 程序化展开（聊天里的文件链接定位）不走 onClick，所以「open 但还没加载过」
   * 时自己拉一次子目录；autoLoadRef 保证失败后不会无限重试。
   */
  const autoLoadRef = useRef(false);
  useEffect(() => {
    if (!open) {
      autoLoadRef.current = false;
      return;
    }
    if (loaded || autoLoadRef.current) return;
    autoLoadRef.current = true;
    void loadChildren();
  }, [open, loaded, loadChildren]);

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
      onSelectPath?.(node.fullPath);
      onOpenFile(node.fullPath, node.name);
    }
  }, [
    node.isDir,
    node.fullPath,
    node.name,
    loaded,
    open,
    loadChildren,
    onOpenFile,
    onToggleExpanded,
    onSelectPath,
  ]);

  return (
    <div>
      <div
        ref={(el) => registerRow?.(node.fullPath, el)}
        onClick={handleClick}
        draggable={!node.isDir}
        onDragStart={(event) => {
          if (node.isDir) return;
          event.dataTransfer.setData(FILE_DRAG_MIME, node.fullPath);
          event.dataTransfer.setData("text/plain", `@${getRelativeFilePath(node.fullPath, cwd)}`);
          event.dataTransfer.effectAllowed = "copy";
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onContextMenuNode(node, event.clientX, event.clientY);
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
          background: isSelected
            ? "#E8EFFB"
            : hovered
              ? "var(--bg-hover)"
              : "transparent",
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
            color: isSelected ? "#2563EB" : "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            fontWeight: mark || isSelected ? 600 : 400,
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
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshKey={refreshKey}
              gitStatus={gitStatus}
              onContextMenuNode={onContextMenuNode}
              selectedPath={selectedPath}
              onSelectPath={onSelectPath}
              registerRow={registerRow}
            />
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

export function FileExplorer({ cwd, onOpenFile, onOpenDiff, refreshKey, onAtMention, reveal }: Props) {
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Agent Host 还没起来时（管道 ENOENT）自动重试，避免永远停在「等待引擎」。
  const [retryTick, setRetryTick] = useState(0);
  const retryCountRef = useRef(0);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [gitStatus, setGitStatus] = useState<GitStatusMap>({});
  const prevCwdRef = useRef<string | null>(null);

  // ---- 文件操作（右键菜单）：复制 / 剪切 / 粘贴 / 重命名 / 删除 / 新建 / 在资源管理器中显示 ----
  const [menu, setMenu] = useState<{ node: FileNode; x: number; y: number } | null>(null);
  const [clipboard, setClipboard] = useState<{ path: string; name: string; mode: "copy" | "move" } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ kind: "rename" | "newfile" | "newfolder"; target: string; value: string } | null>(null);
  const [opBusy, setOpBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  // 菜单操作成功后自己的刷新位（父级 refreshKey 只在 agent 写文件时 bump）
  const [localRefresh, setLocalRefresh] = useState(0);
  const treeRefreshKey = (refreshKey ?? 0) + localRefresh;

  const runFileOp = useCallback(async (target: string, body: Record<string, unknown>) => {
    setOpBusy(true);
    setOpError(null);
    try {
      const res = await fetch(`/api/files/${encodeFilePathForApi(target)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setOpError(payload?.error ?? `操作失败（HTTP ${res.status}）`);
        setOpBusy(false);
        return false;
      }
      setOpBusy(false);
      setMenu(null);
      setPendingDelete(null);
      setPrompt(null);
      setLocalRefresh((tick) => tick + 1);
      return true;
    } catch (error) {
      setOpBusy(false);
      setOpError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, []);

  const revealInOs = useCallback((fullPath: string) => {
    const api = (window as unknown as { electronAPI?: { revealPath?: (target: string) => Promise<unknown> } }).electronAPI;
    if (api?.revealPath) {
      void api.revealPath(fullPath);
      return;
    }
    // 浏览器 dev 版没有 shell：退化成复制路径，别静默无反应。
    void navigator.clipboard?.writeText(fullPath).catch(() => {});
  }, []);

  // Git status poll：每次都要起一个 `git status` 子进程，0.9.0 的 5s 一轮在空闲时
  // 就是持续的后台开销（日志里 /api/git/status 一直在跑）。改成 20s，且只在
  // 窗口可见时跑；切回前台会立即拉一次（见 visibilitychange）。
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (typeof document !== "undefined" && document.hidden) return;
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
    // 聚焦/切回前台会触发一次刷新，但**必须节流**：alt-tab 风暴会让每次聚焦都
    // 起一趟 `git status`（worker + 两个 git 进程，实测 300–400 ms）。
    let lastRefreshAt = 0;
    const onVisible = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (Date.now() - lastRefreshAt < 30_000) return;
      lastRefreshAt = Date.now();
      load();
    };
    lastRefreshAt = Date.now();
    load();
    // **不挂定时器**：`git status` 每次要新建 worker + 两个 git 进程，实测并发时
    // 单次从 250ms 涨到 2.5–4s，全部记在 Agent Host 的 CPU 上。刷新时机改为
    // 「窗口重新可见 / 重新聚焦 / refreshKey 变化（agent 写完文件后 UI 主动 bump）」，
    // 这已经覆盖了用户真正能感知的场景。
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [cwd, refreshKey]);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  // ---- 聊天文件链接定位：展开祖先目录 + 滚动 + 高亮 ----
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const registerRow = useCallback((fullPath: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(fullPath, el);
    else rowRefs.current.delete(fullPath);
  }, []);
  const revealPath = reveal?.path ?? null;
  const revealNonce = reveal?.nonce ?? 0;

  useEffect(() => {
    if (!revealPath || revealNonce === 0) return;
    // 文件不在当前项目内（其它项目 / 用户目录）：树里没有这个节点，别乱展开。
    const { ancestors, target } = computeRevealChain(cwd, revealPath);
    if (!target) {
      setSelectedPath(null);
      return;
    }
    setSelectedPath(target);
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      for (const dir of ancestors) next.add(dir);
      return next;
    });
  }, [revealPath, revealNonce, cwd]);

  // 懒加载逐层展开，行不是立刻存在：rAF 轮询直到该行挂载再滚动（最多约 1.5s）。
  useEffect(() => {
    if (!selectedPath || revealNonce === 0) return;
    let frame = 0;
    let attempts = 0;
    let cancelled = false;
    const findAndScroll = () => {
      if (cancelled) return;
      const row = rowRefs.current.get(selectedPath);
      if (row) {
        row.scrollIntoView({ block: "center" });
        return;
      }
      attempts += 1;
      if (attempts > 90) return;
      frame = requestAnimationFrame(findAndScroll);
    };
    frame = requestAnimationFrame(findAndScroll);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [selectedPath, revealNonce]);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) setExpandedPaths(new Set());

    setLoading(cwdChanged);
    setError(null);
    fetchEntries(cwd)
      .then((entries) => {
        setRoots(entries);
        retryCountRef.current = 0;
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [cwd, refreshKey, retryTick, localRefresh]);

  // 传输层错误（Host 管道未就绪）→ 每 2s 自动重试一次，最多 15 次；
  // 引擎起来后文件树会自己恢复，不需要用户手动刷新。
  useEffect(() => {
    if (!error || !isHostTransportError(error)) return;
    if (retryCountRef.current >= 15) return;
    const timer = setTimeout(() => {
      retryCountRef.current += 1;
      setRetryTick((tick) => tick + 1);
    }, 2000);
    return () => clearTimeout(timer);
  }, [error]);

  if (loading) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
        Loading files...
      </div>
    );
  }

  if (error) {
    const detail = visibleErrorMessage(error);
    if (!detail) {
      // Transport noise (Agent Host pipe not up yet, socket reset while the
      // engine restarts) must not leak into the UI as a red crash line.
      const exhausted = retryCountRef.current >= 15;
      return (
        <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
          <div>{exhausted ? "本地引擎仍未就绪，请重启应用。" : "正在等待本地引擎就绪…（自动重试中）"}</div>
          <button
            type="button"
            onClick={() => {
              retryCountRef.current = 0;
              setRetryTick((tick) => tick + 1);
            }}
            style={{
              marginTop: 6,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-dim)",
              fontSize: 11,
              padding: "2px 8px",
              cursor: "pointer",
            }}
          >
            立即重试
          </button>
        </div>
      );
    }
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--danger)" }}>
        {detail}
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
          refreshKey={treeRefreshKey}
          gitStatus={gitStatus}
          selectedPath={selectedPath}
          onSelectPath={setSelectedPath}
          registerRow={registerRow}
          onContextMenuNode={(target, x, y) => {
            setMenu({ node: target, x, y });
            setPendingDelete(null);
            setOpError(null);
          }}
        />
      ))}
      {roots.length === 0 && (
        <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
          No files found
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => {
            setMenu(null);
            setPendingDelete(null);
          }}
          items={[
            {
              label: "复制路径",
              run: () => {
                void navigator.clipboard?.writeText(menu.node.fullPath).catch(() => {});
                setMenu(null);
              },
            },
            {
              label: "复制",
              run: () => {
                setClipboard({ path: menu.node.fullPath, name: menu.node.name, mode: "copy" });
                setMenu(null);
              },
            },
            {
              label: "剪切",
              run: () => {
                setClipboard({ path: menu.node.fullPath, name: menu.node.name, mode: "move" });
                setMenu(null);
              },
            },
            ...(clipboard && menu.node.isDir && parentDirOf(clipboard.path) !== menu.node.fullPath
              ? [
                  {
                    label: `粘贴「${clipboard.name}」`,
                    run: () => {
                      void runFileOp(clipboard.path, { op: clipboard.mode, to: menu.node.fullPath }).then((ok) => {
                        if (ok) setClipboard(null);
                      });
                    },
                  },
                ]
              : []),
            {
              label: "在资源管理器中显示",
              run: () => {
                revealInOs(menu.node.fullPath);
                setMenu(null);
              },
            },
            {
              label: "重命名",
              run: () => {
                setPrompt({ kind: "rename", target: menu.node.fullPath, value: menu.node.name });
                setOpError(null);
              },
            },
            ...(menu.node.isDir
              ? [
                  {
                    label: "新建文件",
                    run: () => {
                      setPrompt({ kind: "newfile", target: menu.node.fullPath, value: "" });
                      setOpError(null);
                    },
                  },
                  {
                    label: "新建文件夹",
                    run: () => {
                      setPrompt({ kind: "newfolder", target: menu.node.fullPath, value: "" });
                      setOpError(null);
                    },
                  },
                ]
              : []),
            pendingDelete === menu.node.fullPath
              ? {
                  label: "确认删除（不可撤销）",
                  danger: true,
                  run: () => {
                    void runFileOp(menu.node.fullPath, { op: "delete" });
                  },
                }
              : {
                  label: "删除",
                  danger: true,
                  run: () => setPendingDelete(menu.node.fullPath),
                },
          ]}
        />
      )}
      {prompt && (
        <FileOpPrompt
          title={prompt.kind === "rename" ? "重命名" : prompt.kind === "newfile" ? "新建文件" : "新建文件夹"}
          value={prompt.value}
          busy={opBusy}
          error={opError}
          onChange={(value) => setPrompt((prev) => (prev ? { ...prev, value } : prev))}
          onCancel={() => {
            setPrompt(null);
            setOpError(null);
          }}
          onSubmit={() => {
            const name = prompt.value.trim();
            if (!name) {
              setOpError("名字不能为空");
              return;
            }
            const body =
              prompt.kind === "rename"
                ? { op: "rename", name }
                : { op: prompt.kind === "newfile" ? "touch" : "mkdir", name };
            void runFileOp(prompt.target, body);
          }}
        />
      )}
    </div>
  );
}
