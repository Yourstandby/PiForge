"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  ModelCostCurrency,
  ModelCostTier,
  ModelEntry,
  ModelTestState,
  ProviderEntry,
} from "./types";
import { SectionTitle, Field, TextInput, NumInput, Select, Check, API_OPTIONS } from "./FormControls";
import { ThinkingLevelMapEditor } from "./ThinkingLevelMapEditor";
import { useI18n } from "../I18nProvider";

type CostRateKey = "input" | "output" | "cacheRead" | "cacheWrite";

const DEEPSEEK_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
} as const;

function hasDeepseekCompat(model: ModelEntry): boolean {
  return model.compat?.thinkingFormat === "deepseek";
}

function setDeepseekCompat(model: ModelEntry, enabled: boolean): ModelEntry {
  if (enabled) {
    return { ...model, compat: { ...(model.compat ?? {}), ...DEEPSEEK_COMPAT } };
  }
  if (!model.compat) return model;
  const rest = { ...model.compat };
  delete rest.thinkingFormat;
  delete rest.requiresReasoningContentOnAssistantMessages;
  return { ...model, compat: Object.keys(rest).length ? rest : undefined };
}

export function ModelDetail({
  providerName,
  provider,
  model,
  onChange,
  onDelete,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  onChange: (m: ModelEntry) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v });
  const costVal = (k: CostRateKey) => model.cost?.[k] !== undefined ? String(model.cost[k]) : "";
  const setCost = (k: CostRateKey, v: string) => {
    const n = parseFloat(v);
    onChange({ ...model, cost: { ...(model.cost ?? {}), [k]: isNaN(n) ? undefined : n } });
  };
  const costCurrency: ModelCostCurrency = model.cost?.currency ?? "USD";
  const setCostCurrency = (currency: ModelCostCurrency) =>
    onChange({ ...model, cost: { ...(model.cost ?? {}), currency } });
  const tiers = model.cost?.tiers ?? [];
  const setTiers = (next: ModelCostTier[]) =>
    onChange({ ...model, cost: { ...(model.cost ?? {}), tiers: next.length ? next : undefined } });
  const updateTier = (index: number, patchValue: Partial<ModelCostTier>) =>
    setTiers(tiers.map((tier, i) => (i === index ? { ...tier, ...patchValue } : tier)));
  const testSummary = (() => {
    if (testState.phase === "idle") return null;
    if (testState.phase === "testing") return t("provider.testing");
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
      return [t("common.connected"), ...meta, testState.responseText || null].filter(Boolean).join(" · ");
    }
    return [t("common.failed"), ...meta, testState.message].filter(Boolean).join(" · ");
  })();

  useEffect(() => {
    setTestState({ phase: "idle" });
  }, [providerName, provider.baseUrl, provider.api, provider.apiKey, model.id, model.api]);

  const handleTest = useCallback(async () => {
    if (!model.id.trim() || testState.phase === "testing") return;
    setTestState({ phase: "testing" });
    try {
      const res = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName, provider, model }),
      });
      const d = await res.json() as {
        ok?: boolean;
        error?: string;
        latencyMs?: number;
        status?: number;
        responseText?: string;
      };
      if (!res.ok || !d.ok) {
        setTestState({
          phase: "error",
          message: d.error ?? `HTTP ${res.status}`,
          latencyMs: d.latencyMs,
          status: d.status,
        });
        return;
      }
      setTestState({
        phase: "success",
        latencyMs: d.latencyMs,
        status: d.status,
        responseText: d.responseText,
      });
    } catch (e) {
      setTestState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [model, provider, providerName, testState.phase]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("provider.model")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {testSummary && (
            <span
              title={testSummary}
              style={{
                maxWidth: 260,
                height: 24,
                padding: "0 8px",
                border: `1px solid ${testState.phase === "error" ? "#fecaca" : testState.phase === "success" ? "#bbf7d0" : "var(--border)"}`,
                borderRadius: 4,
                background: testState.phase === "error" ? "#fee2e2" : testState.phase === "success" ? "#dcfce7" : "var(--border)",
                color: "var(--text-strong)",
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                boxSizing: "border-box",
              }}
            >
              {testSummary}
            </span>
          )}
          <button
            onClick={handleTest}
            disabled={!model.id.trim() || testState.phase === "testing"}
            title={t("provider.testModel")}
            style={{
              height: 24,
              padding: "0 8px",
              background: testState.phase === "success" ? "#16a34a" : "none",
              border: `1px solid ${testState.phase === "success" ? "#16a34a" : "var(--border)"}`,
              borderRadius: 4,
              color: testState.phase === "success" ? "var(--accent-contrast)" : (!model.id.trim() || testState.phase === "testing") ? "var(--text-dim)" : "var(--text-muted)",
              cursor: (!model.id.trim() || testState.phase === "testing") ? "not-allowed" : "pointer",
              fontSize: 11,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              boxSizing: "border-box",
              gap: 5,
            }}
          >
            {testState.phase === "success" && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {testState.phase === "testing" ? t("provider.testing") : testState.phase === "success" ? t("common.success") : t("common.test")}
          </button>
          <button onClick={onDelete}
            style={{ height: 24, padding: "0 8px", background: "none", border: "1px solid var(--danger-border)", borderRadius: 4, color: "var(--danger)", cursor: "pointer", fontSize: 11, boxSizing: "border-box" }}>
            {t("common.remove")}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="ID *"><TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono /></Field>
        <Field label={t("provider.name")}><TextInput value={model.name ?? ""} onChange={(v) => set("name", v || undefined)} placeholder={t("provider.displayName")} /></Field>
      </div>

      <Field label={t("provider.apiOverride")}>
        <Select value={model.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
      </Field>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Check label={t("provider.reasoning")} checked={model.reasoning ?? false} onChange={(v) => set("reasoning", v || undefined)} />
        <Check label={t("provider.imageInput")} checked={model.input?.includes("image") ?? false}
          onChange={(v) => set("input", v ? ["text", "image"] : undefined)} />
      </div>

      {model.reasoning && (
        <>
          <Check
            label="DeepSeek thinking compat"
            checked={hasDeepseekCompat(model)}
            onChange={(v) => onChange(setDeepseekCompat(model, v))}
          />
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <SectionTitle>{t("provider.thinkingMap")}</SectionTitle>
              {model.thinkingLevelMap && (
                <button
                  onClick={() => set("thinkingLevelMap", undefined)}
                  style={{ fontSize: 10, padding: "2px 7px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-dim)", cursor: "pointer" }}
                >
                  {t("provider.clearAll")}
                </button>
              )}
            </div>
            <ThinkingLevelMapEditor
              value={model.thinkingLevelMap}
              onChange={(v) => set("thinkingLevelMap", v)}
            />
          </div>
        </>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label={t("provider.contextWindow")}>
          <NumInput value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
            onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)} placeholder="128000" />
        </Field>
        <Field label={t("provider.maxTokens")}>
          <NumInput value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
            onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)} placeholder="16384" />
        </Field>
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <SectionTitle>{t("provider.cost")}</SectionTitle>
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
            {costCurrency === "CNY" ? "人民币 / 百万 tokens" : "USD / 百万 tokens"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {(["USD", "CNY"] as const).map((cur) => {
            const active = costCurrency === cur;
            return (
              <button
                key={cur}
                onClick={() => setCostCurrency(cur)}
                style={{
                  fontSize: 10,
                  padding: "3px 9px",
                  borderRadius: 4,
                  cursor: "pointer",
                  border: "1px solid " + (active ? "var(--accent)" : "var(--border)"),
                  background: active ? "var(--accent)" : "none",
                  color: active ? "#fff" : "var(--text-dim)",
                }}
              >
                {cur}
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
          {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
            <Field key={k} label={k}>
              <NumInput value={costVal(k)} onChange={(v) => setCost(k, v)} placeholder="0" />
            </Field>
          ))}
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              {costCurrency === "CNY"
                ? "分档计价：单次请求输入超过阈值后，整单改用该档单价"
                : "Tiered pricing: the whole request switches tier once its input exceeds the threshold"}
            </span>
            <button
              onClick={() =>
                setTiers([
                  ...tiers,
                  {
                    inputTokensAbove: 128000,
                    input: model.cost?.input,
                    output: model.cost?.output,
                    cacheRead: model.cost?.cacheRead,
                    cacheWrite: model.cost?.cacheWrite,
                  },
                ])
              }
              style={{ fontSize: 11, padding: "2px 8px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-dim)", cursor: "pointer" }}
            >
              +
            </button>
          </div>
          {tiers.map((tier, index) => (
            <div key={index} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 1fr auto", gap: 6, marginBottom: 6 }}>
              <NumInput
                value={String(tier.inputTokensAbove ?? "")}
                onChange={(v) => updateTier(index, { inputTokensAbove: v ? parseInt(v) : 0 })}
                placeholder="128000"
              />
              {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
                <NumInput
                  key={k}
                  value={tier[k] !== undefined ? String(tier[k]) : ""}
                  onChange={(v) => updateTier(index, { [k]: v ? parseFloat(v) : undefined } as Partial<ModelCostTier>)}
                  placeholder={k}
                />
              ))}
              <button
                onClick={() => setTiers(tiers.filter((_, i) => i !== index))}
                style={{ fontSize: 11, padding: "2px 8px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-dim)", cursor: "pointer" }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
