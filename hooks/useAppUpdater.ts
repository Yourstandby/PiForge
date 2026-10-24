"use client";

/**
 * 应用自动更新（Main 主导）的渲染侧桥接。
 *
 * - 只读 Main 广播的快照，不碰网络/文件；
 * - 点击时先做乐观更新（立刻进 checking / downloading 0%），让反馈 < 100ms，
 *   真实快照随后覆盖 —— 这是"点了不能卡半天"的前半段，后半段在控制器里（超时）。
 * - 浏览器开发模式没有 preload，`api` 为 null，UI 自行隐藏。
 */

import { useCallback, useEffect, useState } from "react";
import { getElectronApi, type UpdateSnapshot, type UpdaterApi } from "@/lib/electron-api";

export interface AppUpdater {
  /** 仅打包版 Electron 才为 true。 */
  supported: boolean;
  snapshot: UpdateSnapshot | null;
  check: () => void;
  download: () => void;
  install: () => void;
  rollback: (version: string) => Promise<{ ok: boolean; error?: string }>;
  loadArchives: () => Promise<string[]>;
}

export function useAppUpdater(): AppUpdater {
  const [api, setApi] = useState<UpdaterApi | null>(null);
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);

  // preload 只在客户端存在：放进 effect，避免首屏水合不一致。
  useEffect(() => {
    setApi(getElectronApi()?.updater ?? null);
  }, []);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api
      .getState()
      .then((next) => {
        if (alive) setSnapshot(next);
      })
      .catch(() => {
        // Main 还没准备好：保持空快照，等广播
      });
    const unsubscribe = api.onState((next) => setSnapshot(next));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);

  const check = useCallback(() => {
    if (!api) return;
    setSnapshot((prev) => (prev ? { ...prev, phase: "checking", busy: true, error: null } : prev));
    void api.check().then(setSnapshot).catch(() => {
      setSnapshot((prev) => (prev ? { ...prev, phase: "error", busy: false, error: "检查失败" } : prev));
    });
  }, [api]);

  const download = useCallback(() => {
    if (!api) return;
    setSnapshot((prev) =>
      prev ? { ...prev, phase: "downloading", percent: 0, busy: true, error: null } : prev,
    );
    void api.download().then(setSnapshot).catch(() => {
      setSnapshot((prev) => (prev ? { ...prev, phase: "error", busy: false, error: "下载失败" } : prev));
    });
  }, [api]);

  const install = useCallback(() => {
    if (!api) return;
    setSnapshot((prev) => (prev ? { ...prev, busy: true } : prev));
    void api.install().catch(() => {
      setSnapshot((prev) => (prev ? { ...prev, busy: false, error: "重启安装失败" } : prev));
    });
  }, [api]);

  const rollback = useCallback(
    async (version: string) => {
      if (!api) return { ok: false, error: "仅桌面端支持回退" };
      return api.rollback(version);
    },
    [api],
  );

  const loadArchives = useCallback(async () => {
    if (!api) return [];
    try {
      const archives = await api.archives();
      return archives.map((archive) => archive.version);
    } catch {
      return [];
    }
  }, [api]);

  return {
    supported: api !== null && (snapshot === null || snapshot.phase !== "unsupported"),
    snapshot,
    check,
    download,
    install,
    rollback,
    loadArchives,
  };
}
