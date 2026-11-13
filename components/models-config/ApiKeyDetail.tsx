"use client";

import { useState, useEffect, useCallback } from "react";
import type { ApiKeyProvider, ModelTestState } from "./types";
import { Field, SecretTextInput, SectionTitle } from "./FormControls";
import { useI18n } from "../I18nProvider";
import { ErrorNotice } from "../ErrorNotice";

export function ApiKeyDetail({ provider, onRefresh }: { provider: ApiKeyProvider; onRefresh: () => void }) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const envVars = provider.envVars ?? [];
  const [credentialSource, setCredentialSource] = useState<"stored" | "env">(
    provider.source === "environment" ? "env" : "stored"
  );
  const canTest = credentialSource === "env" ? Boolean(provider.envVarSet) : provider.configured;

  // Reset state when provider changes
  useEffect(() => {
    setApiKey("");
    setError(null);
    setSavedOk(false);
    setTestState({ phase: "idle" });
    setCredentialSource(provider.source === "environment" ? "env" : "stored");
  }, [provider.id, provider.source]);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setError(d.error ?? `HTTP ${res.status}`);
      } else {
        setApiKey("");
        setSavedOk(true);
        // A new key invalidates the previous probe result.
        setTestState({ phase: "idle" });
        setTimeout(() => setSavedOk(false), 2000);
        onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [apiKey, provider.id, onRefresh]);

  // Provider-level probe: no model is chosen here, so the server picks the
  // cheapest non-reasoning model of this provider and reports its latency.
  const handleTest = useCallback(async () => {
    if (!canTest || testState.phase === "testing") return;
    setTestState({ phase: "testing" });
    try {
      const res = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerName: provider.id,
          ...(credentialSource === "env" ? { authSource: "env" } : {}),
        }),
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
      setTestState({ phase: "success", latencyMs: d.latencyMs, status: d.status, responseText: d.responseText });
    } catch (e) {
      setTestState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [canTest, credentialSource, provider.id, testState.phase]);

  const testSummary = (() => {
    if (testState.phase === "idle") return null;
    if (testState.phase === "testing") return t("provider.testing");
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") return [t("common.connected"), ...meta].filter(Boolean).join(" · ");
    return [t("common.failed"), ...meta, testState.message].filter(Boolean).join(" · ");
  })();

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setError(d.error ?? `HTTP ${res.status}`);
      } else {
        setTestState({ phase: "idle" });
        onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoving(false);
    }
  }, [provider.id, onRefresh]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("provider.apiKey")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.configured ? "var(--success)" : "var(--border)", display: "inline-block" }} />
          <span style={{ fontSize: 11, color: provider.configured ? "var(--success)" : "var(--text-dim)" }}>
            {provider.configured ? t("common.configured") : t("common.notConfigured")}
          </span>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {provider.configured
          ? t("provider.apiKeyStored")
          : t(provider.modelCount === 1 ? "provider.apiKeyEnableModel" : "provider.apiKeyEnableModels", {
              provider: provider.displayName,
              count: provider.modelCount,
            })}
      </p>

      <Field label={t("provider.apiKey")}>
        <div style={{ display: "flex", gap: 6 }}>
          <SecretTextInput
            value={apiKey}
            onChange={setApiKey}
            onKeyDown={(e) => { if (e.key === "Enter" && apiKey.trim()) handleSave(); }}
            placeholder={provider.configured ? t("provider.replaceApiKey") : "sk-…"}
            style={{ flex: 1 }}
            autoComplete="off"
            spellCheck={false}
            mono
          />
          <button
            onClick={handleSave}
            disabled={saving || !apiKey.trim() || savedOk}
            style={{
              padding: "6px 12px",
              background: savedOk ? "#16a34a" : apiKey.trim() ? "var(--accent)" : "var(--bg-panel)",
              border: "none", borderRadius: 5,
              color: (apiKey.trim() || savedOk) ? "var(--accent-contrast)" : "var(--text-dim)",
              cursor: (saving || !apiKey.trim() || savedOk) ? "not-allowed" : "pointer",
              fontSize: 12, fontWeight: 600, flexShrink: 0,
              display: "flex", alignItems: "center", gap: 5,
            }}
          >
            {savedOk && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {savedOk ? t("common.saved") : saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </Field>

      {error && (
        <ErrorNotice
          message={error}
          style={{ display: "block", margin: 0, fontSize: 12, color: "var(--danger)" }}
        />
      )}

      {envVars.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("provider.credentialSource")}</span>
            {(["stored", "env"] as const).map((source) => {
              const active = credentialSource === source;
              return (
                <button
                  key={source}
                  onClick={() => {
                    setCredentialSource(source);
                    setTestState({ phase: "idle" });
                  }}
                  aria-pressed={active}
                  style={{
                    padding: "3px 10px",
                    borderRadius: 4,
                    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                    background: active ? "var(--accent)" : "none",
                    color: active ? "var(--accent-contrast)" : "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {source === "stored" ? t("provider.credentialStored") : t("provider.credentialEnv")}
                </button>
              );
            })}
          </div>
          {credentialSource === "env" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" }}>
              {envVars.map((name) => {
                const isSet = name === provider.envVarSet;
                return (
                  <div key={name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: isSet ? "var(--success)" : "var(--border)", display: "inline-block", flexShrink: 0 }} />
                    <span style={{ fontFamily: "var(--font-mono)" }}>{name}</span>
                    <span style={{ color: isSet ? "var(--success)" : "var(--text-dim)" }}>
                      {isSet ? t("provider.envVarSet") : t("provider.envVarUnset")}
                    </span>
                  </div>
                );
              })}
              {!provider.envVarSet && (
                <div>{t("provider.envVarHint", { vars: envVars.join(", ") })}</div>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={handleTest}
          disabled={!canTest || testState.phase === "testing"}
          title={t("provider.testConnection")}
          style={{
            padding: "5px 12px",
            background: "none",
            border: `1px solid ${testState.phase === "error" ? "var(--danger-border)" : "var(--border)"}`,
            borderRadius: 5,
            color: !canTest ? "var(--text-dim)" : "var(--text-muted)",
            cursor: (!canTest || testState.phase === "testing") ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          {testState.phase === "testing" ? t("provider.testing") : t("provider.testConnection")}
        </button>
        {testSummary && (
          <span
            title={testSummary}
            style={{
              maxWidth: 320,
              padding: "3px 8px",
              border: `1px solid ${testState.phase === "error" ? "#fecaca" : testState.phase === "success" ? "#bbf7d0" : "var(--border)"}`,
              borderRadius: 4,
              background: testState.phase === "error" ? "#fee2e2" : testState.phase === "success" ? "#dcfce7" : "var(--border)",
              color: "var(--text-strong)",
              fontSize: 11,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              boxSizing: "border-box",
            }}
          >
            {testSummary}
          </span>
        )}
      </div>

      {provider.configured && (
        <button
          onClick={handleRemove}
          disabled={removing}
          style={{
            alignSelf: "flex-start", padding: "5px 12px",
            background: "none", border: "1px solid var(--danger-border)",
            borderRadius: 5, color: "var(--danger)",
            cursor: removing ? "not-allowed" : "pointer", fontSize: 12,
          }}
        >
          {removing ? t("common.removing") : t("common.disconnect")}
        </button>
      )}
    </div>
  );
}
