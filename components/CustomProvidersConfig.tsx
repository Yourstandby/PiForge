"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CustomProviderInput,
  CustomProviderView,
  HostTransportInfo,
} from "@/contract/domains/providers";

interface ProvidersResponse {
  providers?: CustomProviderView[];
  transport?: HostTransportInfo;
  error?: string;
}

interface Draft {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: string;
}

const EMPTY_DRAFT: Draft = {
  id: "",
  name: "",
  baseUrl: "http://127.0.0.1:11434/v1",
  api: "openai-completions",
  apiKey: "",
  models: "",
};

const API_OPTIONS = [
  ["openai-completions", "OpenAI Chat Completions 兼容"],
  ["openai-responses", "OpenAI Responses 兼容"],
  ["anthropic-messages", "Anthropic Messages 兼容"],
] as const;

function parseModels(text: string): { id: string; name?: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...name] = line.split("|");
      const cleanId = id.trim();
      const cleanName = name.join("|").trim();
      return { id: cleanId, ...(cleanName ? { name: cleanName } : {}) };
    })
    .filter((model) => model.id.length > 0);
}

function draftFor(provider: CustomProviderView): Draft {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey: "",
    models: provider.models.map((model) => model.name ? `${model.id}|${model.name}` : model.id).join("\n"),
  };
}

export function CustomProvidersConfig({ onClose }: { onClose: () => void }) {
  const [providers, setProviders] = useState<CustomProviderView[]>([]);
  const [transport, setTransport] = useState<HostTransportInfo | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/providers", { cache: "no-store" });
      const data = (await response.json()) as ProvidersResponse;
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProviders(data.providers ?? []);
      setTransport(data.transport ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const modelCount = useMemo(() => parseModels(draft.models).length, [draft.models]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const input: CustomProviderInput = {
        id: draft.id.trim(),
        name: draft.name.trim() || draft.id.trim(),
        baseUrl: draft.baseUrl.trim(),
        api: draft.api,
        models: parseModels(draft.models),
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      };
      const response = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = (await response.json()) as { provider?: CustomProviderView; error?: string };
      if (!response.ok || !data.provider) throw new Error(data.error ?? `HTTP ${response.status}`);
      setNotice(`已保存 ${data.provider.name}，下一条消息生效`);
      setEditing(false);
      setDraft(EMPTY_DRAFT);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, load]);

  const remove = useCallback(async (provider: CustomProviderView) => {
    if (!window.confirm(`删除自定义 Provider「${provider.name}」？`)) return;
    setError(null);
    try {
      const response = await fetch(`/api/providers?id=${encodeURIComponent(provider.id)}`, {
        method: "DELETE",
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setNotice(`已删除 ${provider.name}`);
      if (draft.id === provider.id) {
        setDraft(EMPTY_DRAFT);
        setEditing(false);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [draft.id, load]);

  return (
    <div className="ui-dialog-backdrop" style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.42)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ui-dialog-surface" style={{ width: "min(920px, 94vw)", maxHeight: "84vh", overflow: "auto", background: "var(--material-popover, #fff)", border: "1px solid var(--border, #e5e7eb)", borderRadius: 14, boxShadow: "0 18px 60px rgba(15,23,42,0.18)" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--border, #e5e7eb)" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>自定义 Provider</div>
            <div style={{ fontSize: 11, color: "var(--text-muted, #6b7280)", marginTop: 3 }}>
              Ollama / LM Studio / 自建网关。密钥只保存在 Host 的 agent 目录，界面永远只显示掩码。
            </div>
          </div>
          <button onClick={onClose} aria-label="关闭" style={{ border: 0, background: "none", fontSize: 22, cursor: "pointer", color: "var(--text-muted, #6b7280)" }}>×</button>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 0 }}>
          <aside style={{ borderRight: "1px solid var(--border, #e5e7eb)", padding: 14, minHeight: 360 }}>
            <button
              onClick={() => { setEditing(true); setDraft(EMPTY_DRAFT); setError(null); setNotice(null); }}
              style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1d4ed8", fontWeight: 600, cursor: "pointer" }}
            >
              + 新建 Provider
            </button>
            <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
              {loading && <div style={{ fontSize: 12, color: "#6b7280" }}>加载中…</div>}
              {!loading && providers.length === 0 && <div style={{ fontSize: 12, color: "#6b7280" }}>还没有自定义 Provider。</div>}
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  onClick={() => { setEditing(true); setDraft(draftFor(provider)); setError(null); setNotice(null); }}
                  style={{
                    textAlign: "left", padding: "9px 10px", borderRadius: 8, cursor: "pointer",
                    border: draft.id === provider.id && editing ? "1px solid #93c5fd" : "1px solid transparent",
                    background: draft.id === provider.id && editing ? "#eff6ff" : "transparent",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>{provider.name}</div>
                  <div style={{ fontSize: 11, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{provider.baseUrl}</div>
                  <div style={{ fontSize: 10, color: "#9ca3af" }}>{provider.models.length} 个模型 · {provider.hasApiKey ? "已配置密钥" : "无密钥"}</div>
                </button>
              ))}
            </div>
            {transport && (
              <div style={{ marginTop: 18, paddingTop: 12, borderTop: "1px solid #eef2f7", fontSize: 10, color: "#6b7280", lineHeight: 1.6 }}>
                <div style={{ fontWeight: 700, color: "#374151" }}>Host WebSocket 总线</div>
                <div>{transport.wsUrl ?? "未启动"}</div>
                <div>{transport.wsClients} 个已认证客户端</div>
              </div>
            )}
          </aside>

          <section style={{ padding: 18 }}>
            {!editing && (
              <div style={{ color: "#6b7280", fontSize: 13, lineHeight: 1.8 }}>
                选择左侧 Provider 进行编辑，或新建一个。保存后 Host 会写入 models.json 并让运行中的会话在下一轮重新加载模型。
              </div>
            )}
            {editing && (
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <label style={labelStyle}>Provider ID
                    <input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} placeholder="ollama-local" style={inputStyle} />
                  </label>
                  <label style={labelStyle}>显示名称
                    <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="本地 Ollama" style={inputStyle} />
                  </label>
                </div>
                <label style={labelStyle}>Base URL
                  <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="http://127.0.0.1:11434/v1" style={inputStyle} />
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <label style={labelStyle}>API 协议
                    <select value={draft.api} onChange={(e) => setDraft({ ...draft, api: e.target.value })} style={inputStyle}>
                      {API_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label style={labelStyle}>API Key（留空保留原密钥）
                    <input type="password" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} placeholder="Ollama 可填 ollama" style={inputStyle} autoComplete="off" />
                  </label>
                </div>
                <label style={labelStyle}>模型列表（每行一个，ID|显示名；共 {modelCount} 个）
                  <textarea value={draft.models} onChange={(e) => setDraft({ ...draft, models: e.target.value })} placeholder={"qwen2.5-coder:7b\nllama3.3:70b|Llama 3.3"} rows={8} style={{ ...inputStyle, fontFamily: "var(--font-mono, monospace)", resize: "vertical" }} />
                </label>
                <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.6 }}>
                  本地 Ollama 通常需要任意非空密钥（例如 ollama）才会被 Pi 识别为可用模型；自建网关请填写真实密钥。
                </div>
                {error && <div style={{ color: "#b91c1c", fontSize: 12 }}>{error}</div>}
                {notice && <div style={{ color: "#047857", fontSize: 12 }}>{notice}</div>}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  {providers.some((provider) => provider.id === draft.id) && (
                    <button onClick={() => { const found = providers.find((provider) => provider.id === draft.id); if (found) void remove(found); }} style={{ ...buttonStyle, color: "#b91c1c", borderColor: "#fecaca" }}>删除</button>
                  )}
                  <button onClick={() => { setEditing(false); setDraft(EMPTY_DRAFT); setError(null); }} style={buttonStyle}>取消</button>
                  <button onClick={() => void save()} disabled={saving || !draft.id.trim() || !draft.baseUrl.trim()} style={{ ...buttonStyle, background: "#2563eb", color: "#fff", borderColor: "#2563eb", opacity: saving ? 0.7 : 1 }}>
                    {saving ? "保存中…" : "保存并生效"}
                  </button>
                </div>
              </div>
            )}
            {!editing && error && <div style={{ color: "#b91c1c", fontSize: 12, marginTop: 12 }}>{error}</div>}
            {!editing && notice && <div style={{ color: "#047857", fontSize: 12, marginTop: 12 }}>{notice}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: "grid", gap: 5, fontSize: 11, fontWeight: 600, color: "#4b5563" };
const inputStyle: React.CSSProperties = { width: "100%", padding: "8px 9px", border: "1px solid #d1d5db", borderRadius: 7, background: "#fff", color: "#111827", fontSize: 12, fontWeight: 400, outline: "none" };
const buttonStyle: React.CSSProperties = { padding: "7px 12px", borderRadius: 7, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 12, cursor: "pointer" };
