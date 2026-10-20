"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { ModalSurface } from "./ModalSurface";

interface ModelListItem {
  id: string;
  name: string;
  provider: string;
}

interface Selection {
  provider: string;
  modelId: string;
}

function toKey(selection: Selection | null | undefined): string {
  return selection ? `${selection.provider}:${selection.modelId}` : "";
}

function fromKey(key: string): Selection | null {
  if (!key) return null;
  const separator = key.indexOf(":");
  if (separator === -1) return null;
  return { provider: key.slice(0, separator), modelId: key.slice(separator + 1) };
}

function ModelSelect({
  id,
  label,
  hint,
  value,
  onChange,
  models,
  fallback,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  models: ModelListItem[];
  fallback?: Selection | null;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, ModelListItem[]>();
    for (const model of models) {
      const list = map.get(model.provider) ?? [];
      list.push(model);
      map.set(model.provider, list);
    }
    return [...map.entries()];
  }, [models]);

  return (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-ink">{label}</span>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 rounded-md border border-border bg-white px-2 text-[12px] text-ink outline-none focus:border-accent/50"
      >
        <option value="">
          {fallback
            ? `自动选择（${fallback.provider}/${fallback.modelId}）`
            : "自动选择"}
        </option>
        {groups.map(([provider, options]) => (
          <optgroup key={provider} label={provider}>
            {options.map((model) => (
              <option key={`${model.provider}:${model.id}`} value={`${model.provider}:${model.id}`}>
                {model.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className="text-[11px] leading-4 text-ink-faint">{hint}</span>
    </label>
  );
}

export function AutoRoutingConfig({
  onClose,
}: {
  onClose: () => void;
}) {
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [suggested, setSuggested] = useState<{ fast: Selection | null; strong: Selection | null }>({
    fast: null,
    strong: null,
  });
  const [fast, setFast] = useState("");
  const [strong, setStrong] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/models").then((res) => res.json()),
      fetch("/api/desktop-settings").then((res) => res.json()),
    ])
      .then(
        (data: [
          {
            modelList?: ModelListItem[];
            autoRouting?: { fast?: Selection | null; strong?: Selection | null };
          },
          { autoRoutingFast?: Selection; autoRoutingStrong?: Selection },
        ]) => {
          if (cancelled) return;
          const [modelData, settings] = data;
          setModels(modelData.modelList ?? []);
          setSuggested({
            fast: modelData.autoRouting?.fast ?? null,
            strong: modelData.autoRouting?.strong ?? null,
          });
          setFast(toKey(settings.autoRoutingFast));
          setStrong(toKey(settings.autoRoutingStrong));
        },
      )
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
      const res = await fetch("/api/desktop-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoRoutingFast: fromKey(fast),
          autoRoutingStrong: fromKey(strong),
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
  }, [fast, strong]);

  return (
    <ModalSurface
      panelClassName="t-modal is-open ui-dialog-surface flex w-full max-w-lg flex-col overflow-hidden rounded-[14px]"
      ariaLabelledBy="auto-routing-title"
    >
      <div className="flex items-center justify-between border-b border-divider px-4 py-3">
        <h3 id="auto-routing-title" className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
          <Sparkles size={14} strokeWidth={1.8} className="text-accent" aria-hidden="true" />
          Auto 自动路由
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
          在模型菜单中选择 <span className="font-medium text-ink">Auto</span> 后，PiForge 会按本轮提问的长度、
          关键词、是否附图以及当前上下文大小选择模型：简单任务走快模型，复杂任务走强模型。这里可以覆盖自动挑选的结果。
        </p>

        {loading ? (
          <p className="flex items-center gap-1.5 text-[12px] text-ink-faint">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" /> 读取模型列表…
          </p>
        ) : (
          <>
            <ModelSelect
              id="auto-fast-model"
              label="快模型（简单问题）"
              hint="适合短问答、重命名、单文件小改动等低成本任务。"
              value={fast}
              onChange={setFast}
              models={models}
              fallback={suggested.fast}
            />
            <ModelSelect
              id="auto-strong-model"
              label="强模型（复杂任务）"
              hint="适合重构、架构设计、多文件排查、带图片或长上下文的请求。"
              value={strong}
              onChange={setStrong}
              models={models}
              fallback={suggested.strong}
            />
          </>
        )}

        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
        {saved && <p role="status" className="text-[12px] text-[#3E8A63]">已保存，下一次提问生效。</p>}
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

export default AutoRoutingConfig;
