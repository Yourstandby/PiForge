"use client";

import { useCallback, useEffect, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import {
  getPresetFromTools,
  PRESET_NONE,
  PRESET_DEFAULT,
  PRESET_FULL,
  type ToolEntry,
} from "@/lib/tool-presets";
import type { ThinkingLevelOption } from "./session-lifecycle-reset";
import {
  classifyPromptComplexity,
  resolveAutoModel,
  type AutoRoutingTargets,
} from "@/lib/model-routing";

const AUTO_MODEL_STORAGE_KEY = "piforge.autoModel";

function initialAutoRouting(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AUTO_MODEL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistAutoRouting(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) window.localStorage.setItem(AUTO_MODEL_STORAGE_KEY, "1");
    else window.localStorage.removeItem(AUTO_MODEL_STORAGE_KEY);
  } catch {
    // Private mode / storage disabled: selection still works for this session.
  }
}

type ModelListItem = { id: string; name: string; provider: string; input?: string[] };

interface ModelsPayload {
  models: Record<string, string>;
  modelList?: ModelListItem[];
  defaultModel?: { provider: string; modelId: string } | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  autoRouting?: AutoRoutingTargets;
}

/**
 * `/api/models` 是全局数据（与具体会话无关），且每次请求都要穿过
 * Next→Host 命名管道并重建运行时。以前每开一个会话标签就重拉一次，
 * 快速切会话时会排队阻塞在管道上。这里做模块级缓存 + 在途请求去重：
 * 无论同时挂载多少个 ChatSurface，全局只会有一次真实请求。
 */
let modelsCache: ModelsPayload | null = null;
let modelsInFlight: Promise<ModelsPayload | null> | null = null;
let modelsCacheKey: number | undefined;

function invalidateModelsCache(): void {
  modelsCache = null;
}

function fetchModelsPayload(): Promise<ModelsPayload | null> {
  if (modelsCache) return Promise.resolve(modelsCache);
  if (!modelsInFlight) {
    modelsInFlight = fetch("/api/models")
      .then((r) => r.json() as Promise<ModelsPayload>)
      .then((payload) => {
        modelsCache = payload;
        return payload;
      })
      .catch((err) => {
        console.error("Failed to load model list:", err);
        return null;
      })
      .finally(() => {
        modelsInFlight = null;
      });
  }
  return modelsInFlight;
}

export type UseSessionModelToolsOptions = {
  isNew: boolean;
  modelsRefreshKey?: number;
  sessionIdRef: React.MutableRefObject<string | null>;
};

export function useSessionModelTools(opts: UseSessionModelToolsOptions) {
  const {
    isNew,
    modelsRefreshKey,
    sessionIdRef,
  } = opts;

  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelListItem[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<
    Record<string, Record<string, string | null>>
  >({});
  const [newSessionModel, setNewSessionModelState] = useState<{
    provider: string;
    modelId: string;
  } | null>(null);
  const [toolPreset, setToolPreset] = useState<"none" | "default" | "full">("default");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [currentModelOverride, setCurrentModelOverride] = useState<{
    provider: string;
    modelId: string;
  } | null>(null);
  const [pendingModel, setPendingModel] = useState<{
    provider: string;
    modelId: string;
  } | null>(null);
  const [autoRouting, setAutoRouting] = useState<boolean>(initialAutoRouting);
  const [autoTargets, setAutoTargets] = useState<AutoRoutingTargets>({
    fast: null,
    strong: null,
  });

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools && sessionIdRef.current === sid) {
        setToolPreset(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [sessionIdRef]);

  const handleModelChange = useCallback(
    async (provider: string, modelId: string) => {
      // "Auto" is a desktop-only pseudo model: routing happens per prompt, so
      // there is no provider/model to send to pi here.
      if (provider === "auto") {
        setAutoRouting(true);
        persistAutoRouting(true);
        return;
      }
      setAutoRouting(false);
      persistAutoRouting(false);
      const sid = sessionIdRef.current;
      if (!sid) {
        setNewSessionModelState({ provider, modelId });
        return;
      }
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
        setCurrentModelOverride({ provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
    },
    [sessionIdRef]
  );

  /** Pick fast/strong for one prompt (used by handleSend when Auto is active). */
  const resolveAutoModelForPrompt = useCallback(
    (message: string, hasImages: boolean, contextChars = 0) => {
      const tier = classifyPromptComplexity(message, hasImages, contextChars);
      return resolveAutoModel(autoTargets, tier);
    },
    [autoTargets],
  );

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (level === "auto") return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, [sessionIdRef]);

  const handleToolPresetChange = useCallback(
    async (preset: "none" | "default" | "full") => {
      const toolNames =
        preset === "none" ? PRESET_NONE : preset === "default" ? PRESET_DEFAULT : PRESET_FULL;
      setToolPreset(preset);
      const sid = sessionIdRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_tools", toolNames });
      } catch (e) {
        console.error("Failed to set tools:", e);
      }
    },
    [sessionIdRef]
  );

  useEffect(() => {
    // 模型配置变更（ModelsConfig / 切 provider）会 bump modelsRefreshKey，
    // 只有这时才丢掉缓存。
    if (modelsCacheKey !== modelsRefreshKey) {
      modelsCacheKey = modelsRefreshKey;
      invalidateModelsCache();
    }
    let cancelled = false;
    void fetchModelsPayload().then((d) => {
      if (cancelled || !d) return;
      setModelNames(d.models);
      if (d.autoRouting) setAutoTargets(d.autoRouting);
      if (d.thinkingLevels) setModelThinkingLevels(d.thinkingLevels);
      if (d.thinkingLevelMaps) setModelThinkingLevelMaps(d.thinkingLevelMaps);
      if (d.modelList) {
        setModelList(d.modelList);
        if (isNew && d.modelList.length > 0) {
          const def = d.defaultModel;
          const match =
            def && d.modelList.find((m) => m.id === def.modelId && m.provider === def.provider);
          const selected = match
            ? { provider: match.provider, modelId: match.id }
            : { provider: d.modelList[0].provider, modelId: d.modelList[0].id };
          setNewSessionModelState(selected);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isNew, modelsRefreshKey]);

  return {
    modelNames,
    modelList,
    modelThinkingLevels,
    modelThinkingLevelMaps,
    newSessionModel,
    toolPreset,
    setToolPreset,
    thinkingLevel,
    setThinkingLevel,
    currentModelOverride,
    setCurrentModelOverride,
    autoRouting,
    autoTargets,
    resolveAutoModelForPrompt,
    pendingModel,
    setPendingModel,
    loadTools,
    handleModelChange,
    handleThinkingLevelChange,
    handleToolPresetChange,
  };
}
