"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ImagePlus, Loader2, Shapes } from "lucide-react";
import type {
  AuxModelCatalogue,
  AuxModelOption,
  AuxModelSelection,
} from "@contract/domains/aux-models";
import { ModalSurface } from "./ModalSurface";
import { ErrorNotice } from "./ErrorNotice";

function toKey(selection: AuxModelSelection | null | undefined): string {
  return selection ? `${selection.provider}:${selection.modelId}` : "";
}

function fromKey(key: string): AuxModelSelection | null {
  if (!key) return null;
  const separator = key.indexOf(":");
  if (separator === -1) return null;
  return { provider: key.slice(0, separator), modelId: key.slice(separator + 1) };
}

interface ProviderGroup {
  id: string;
  name: string;
  models: AuxModelOption[];
}

function groupByProvider(options: AuxModelOption[]): ProviderGroup[] {
  const map = new Map<string, ProviderGroup>();
  for (const option of options) {
    const group = map.get(option.provider) ?? { id: option.provider, name: option.providerName, models: [] };
    group.models.push(option);
    map.set(option.provider, group);
  }
  return [...map.values()];
}

function splitKey(key: string): { provider: string; modelId: string } {
  if (!key) return { provider: "", modelId: "" };
  const separator = key.indexOf(":");
  if (separator === -1) return { provider: key, modelId: "" };
  return { provider: key.slice(0, separator), modelId: key.slice(separator + 1) };
}

/** Provider + model dropdown pair (explicit, as asked by the settings spec). */
function ProviderModelPicker({
  id,
  label,
  hint,
  value,
  onChange,
  options,
  emptyHint,
  icon,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  options: AuxModelOption[];
  emptyHint: string;
  icon: React.ReactNode;
}) {
  const groups = useMemo(() => groupByProvider(options), [options]);
  const { provider, modelId } = splitKey(value);
  const active = groups.find((group) => group.id === provider);

  const changeProvider = (next: string) => {
    if (!next) {
      onChange("");
      return;
    }
    const group = groups.find((entry) => entry.id === next);
    const firstModel = group?.models[0];
    onChange(firstModel ? `${next}:${firstModel.id}` : "");
  };

  const changeModel = (next: string) => {
    if (!next || !provider) {
      onChange("");
      return;
    }
    onChange(`${provider}:${next}`);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
        {icon}
        {label}
      </span>
      <div className="grid grid-cols-2 gap-2">
        <label htmlFor={`${id}-provider`} className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-ink-faint">Provider</span>
          <select
            id={`${id}-provider`}
            value={provider}
            onChange={(event) => changeProvider(event.target.value)}
            disabled={options.length === 0}
            className="h-8 rounded-md border border-border bg-white px-2 text-[12px] text-ink outline-none focus:border-accent/50 disabled:bg-[#F5F7FA] disabled:text-ink-faint"
          >
            <option value="">未配置（工具不启用）</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
            {provider && !active && <option value={provider}>当前配置（不可用）</option>}
          </select>
        </label>
        <label htmlFor={`${id}-model`} className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-ink-faint">Model</span>
          <select
            id={`${id}-model`}
            value={modelId}
            onChange={(event) => changeModel(event.target.value)}
            disabled={!active || active.models.length === 0}
            className="h-8 rounded-md border border-border bg-white px-2 text-[12px] text-ink outline-none focus:border-accent/50 disabled:bg-[#F5F7FA] disabled:text-ink-faint"
          >
            {(!active || active.models.length === 0) && (
              <option value={modelId}>{modelId || "—"}</option>
            )}
            {active?.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <span className="text-[11px] leading-4 text-ink-faint">
        {options.length === 0 ? emptyHint : hint}
      </span>
    </div>
  );
}

/**
 * Settings → 辅助模型: picks the image-generation and decision/classifier
 * models. The Host owns the calls; this dialog only reads the catalogue and
 * persists the two selections.
 */
export function AuxModelsConfig({ onClose }: { onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<AuxModelCatalogue | null>(null);
  const [image, setImage] = useState("");
  const [decision, setDecision] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models/auxiliary")
      .then(async (res) => {
        const data = (await res.json()) as AuxModelCatalogue & { error?: string };
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setCatalogue(data);
        setImage(toKey(data.config?.image));
        setDecision(toKey(data.config?.decision));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/models/auxiliary", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: fromKey(image),
          decision: fromKey(decision),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [image, decision]);

  return (
    <ModalSurface
      panelClassName="t-modal is-open ui-dialog-surface flex w-full max-w-lg flex-col overflow-hidden rounded-[14px]"
      ariaLabelledBy="aux-models-title"
    >
      <div className="flex items-center justify-between border-b border-divider px-4 py-3">
        <h3 id="aux-models-title" className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
          <Shapes size={14} strokeWidth={1.8} className="text-accent" aria-hidden="true" />
          辅助模型 · 生图 / 决策
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="rounded px-2 py-1 text-[16px] leading-none text-ink-muted hover:bg-[#ECECEF] hover:text-ink"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-4 px-4 py-4">
        <p className="text-[12px] leading-5 text-ink-muted">
          这两条通道使用独立的非对话模型，调用全部在 Agent Host 内完成。配置后，Agent 会获得
          <span className="font-mono text-[11px] text-ink"> generate_image </span>与
          <span className="font-mono text-[11px] text-ink"> classify_decision </span>
          工具；未配置时不会向模型声明，避免占用提示词。
        </p>

        {loading ? (
          <p className="flex items-center gap-1.5 text-[12px] text-ink-faint">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" /> 读取模型目录…
          </p>
        ) : (
          <>
            <ProviderModelPicker
              id="aux-image-model"
              label="生图模型"
              hint="用于 /imagine 与 generate_image。支持图片输出的提供商（如 OpenRouter）会出现在这里。"
              value={image}
              onChange={setImage}
              options={catalogue?.image ?? []}
              emptyHint="当前没有可用的生图模型：请先在「模型与登录」中配置支持图片生成的提供商。"
              icon={<ImagePlus size={12} strokeWidth={1.9} className="text-accent" aria-hidden="true" />}
            />
            <ProviderModelPicker
              id="aux-decision-model"
              label="决策模型"
              hint="用于 classify_decision：分类、打分或是否判断，成本远低于主模型思考。"
              value={decision}
              onChange={setDecision}
              options={catalogue?.classifier ?? []}
              emptyHint="当前没有可用的决策模型：请先配置支持结构化分类（classifier）的提供商。"
              icon={<Shapes size={12} strokeWidth={1.9} className="text-accent" aria-hidden="true" />}
            />
          </>
        )}

        {error && <ErrorNotice className="block text-[12px] text-danger" message={error} />}
        {saved && (
          <p role="status" className="text-[12px] text-[#3E8A63]">
            已保存，下一次提问生效。
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-divider px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
        >
          关闭
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={loading || saving}
          className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
          保存
        </button>
      </div>
    </ModalSurface>
  );
}

export default AuxModelsConfig;
