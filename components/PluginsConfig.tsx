"use client";

import { useCallback, useEffect, useState } from "react";
import type { PluginView } from "@/contract/domains/plugins";
import type { HostTransportInfo } from "@/contract/domains/providers";
import { ErrorNotice } from "./ErrorNotice";

interface PluginsResponse {
  plugins?: PluginView[];
  transport?: HostTransportInfo;
  error?: string;
}

const STATUS_STYLE: Record<string, { color: string; background: string; border: string }> = {
  loaded: { color: "#2F7A55", background: "#F2FBF5", border: "#CBE6D5" },
  disabled: { color: "var(--text-muted)", background: "var(--bg-panel)", border: "#E1E4EA" },
  error: { color: "#B0443C", background: "#FDF6F5", border: "#F0D3CF" },
};

export function PluginsConfig({ onClose }: { onClose: () => void }) {
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [transport, setTransport] = useState<HostTransportInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/plugins", { cache: "no-store" });
      const data = (await response.json()) as PluginsResponse;
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setPlugins(data.plugins ?? []);
      setTransport(data.transport ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(async (plugin: PluginView) => {
    setBusy(plugin.id);
    setError(null);
    try {
      const response = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: plugin.id, enabled: !plugin.enabled }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [load]);

  return (
    <div className="ui-dialog-backdrop" style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.42)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ui-dialog-surface" style={{ width: "min(920px, 94vw)", maxHeight: "84vh", overflow: "auto", background: "var(--material-popover, var(--bg-elevated))", border: "1px solid var(--border, var(--border))", borderRadius: 14, boxShadow: "0 18px 60px rgba(15,23,42,0.18)" }}>
        <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--border, var(--border))" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>插件管理</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.6 }}>
              插件运行在 Host 的 vm 沙箱中，没有 require / fs / child_process；特权操作必须通过 Host RPC。
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={() => void load()} style={buttonStyle} disabled={loading}>刷新</button>
            <button onClick={onClose} aria-label="关闭" style={{ border: 0, background: "none", fontSize: 22, cursor: "pointer", color: "var(--text-muted)" }}>×</button>
          </div>
        </header>

        <div style={{ padding: 16 }}>
          <div style={{ display: "flex", gap: 12, padding: "10px 12px", borderRadius: 9, background: "#F8FAFC", border: "1px solid var(--border-subtle)", fontSize: 11, color: "var(--text-muted)", marginBottom: 14 }}>
            <div><strong>插件目录</strong> · <code>~/.pi/agent/plugins/&lt;id&gt;/plugin.json</code></div>
            <div style={{ marginLeft: "auto" }}><strong>WS</strong> · {transport?.wsUrl ?? "未启动"} · {transport?.wsClients ?? 0} 客户端</div>
          </div>

          {error && (
          <ErrorNotice
            message={error}
            style={{ display: "block", color: "#b91c1c", fontSize: 12, marginBottom: 12 }}
            fallback={<span style={{ display: "block", fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>正在等待本地引擎就绪…</span>}
          />
        )}
          {loading && <div style={{ color: "var(--text-muted)", fontSize: 12 }}>加载中…</div>}
          {!loading && plugins.length === 0 && (
            <div style={{ padding: 22, textAlign: "center", border: "1px dashed #dbe3ee", borderRadius: 10, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.8 }}>
              还没有插件。在 <code>~/.pi/agent/plugins/demo/</code> 放一个 <code>plugin.json</code> 与 <code>index.js</code>，导出 <code>activate(api)</code> 即可。
            </div>
          )}

          <div style={{ display: "grid", gap: 10 }}>
            {plugins.map((plugin) => {
              const tone = STATUS_STYLE[plugin.status] ?? STATUS_STYLE.disabled;
              return (
                <section key={plugin.id} style={{ border: "1px solid var(--border-subtle)", borderRadius: 10, padding: 13, background: "var(--bg-elevated)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <strong style={{ fontSize: 13, color: "var(--text)" }}>{plugin.name}</strong>
                        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace" }}>{plugin.id}@{plugin.version}</span>
                        <span style={{ fontSize: 9.5, padding: "1px 7px", borderRadius: 999, border: `1px solid ${tone.border}`, background: tone.background, color: tone.color }}>{plugin.status}</span>
                        {plugin.tools.some((tool) => tool.mcp) && <span style={{ fontSize: 9.5, color: "#1d4ed8" }}>MCP 工具</span>}
                      </div>
                      {plugin.description && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>{plugin.description}</div>}
                      {plugin.error && <div style={{ fontSize: 11, color: "#b91c1c", marginTop: 4 }}>{plugin.error}</div>}
                    </div>
                    <button onClick={() => void toggle(plugin)} disabled={busy === plugin.id} style={{ ...buttonStyle, background: plugin.enabled ? "var(--bg-elevated)" : "var(--accent)", color: plugin.enabled ? "var(--text)" : "var(--bg-elevated)", borderColor: plugin.enabled ? "var(--border)" : "var(--accent)" }}>
                      {busy === plugin.id ? "切换中…" : plugin.enabled ? "禁用" : "启用"}
                    </button>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 9, fontSize: 10.5, color: "var(--text-muted)" }}>
                    <span>{plugin.tools.length} 个工具</span>
                    <span>{plugin.prompts} 条提示词注入</span>
                    <span>{plugin.panels.length} 个面板</span>
                    {plugin.loadedAt && <span>加载于 {new Date(plugin.loadedAt).toLocaleTimeString()}</span>}
                  </div>

                  {plugin.tools.length > 0 && (
                    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 5 }}>
                      {plugin.tools.map((tool) => (
                        <span key={tool.name} title={tool.description} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, background: tool.mcp ? "var(--bg-selected)" : "var(--bg-panel)", color: tool.mcp ? "#1d4ed8" : "var(--text-muted)", fontFamily: "monospace" }}>
                          {tool.name.replace(/^plugin__[^_]+__/, "")}
                        </span>
                      ))}
                    </div>
                  )}

                  {plugin.panels.length > 0 && (
                    <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                      {plugin.panels.map((panel) => (
                        <details key={panel.id} style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          <summary style={{ cursor: "pointer" }}>面板：{panel.title}</summary>
                          <pre style={{ whiteSpace: "pre-wrap", background: "#F8FAFC", padding: 8, borderRadius: 6, marginTop: 5, fontFamily: "var(--font-mono, monospace)", fontSize: 10.5 }}>{panel.body || "(空面板)"}</pre>
                        </details>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = { padding: "7px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text)", fontSize: 12, cursor: "pointer" };
