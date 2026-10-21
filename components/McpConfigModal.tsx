"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { McpServerStatus, McpServerConfig } from "@/lib/mcp-config";
import type { McpAuthState, McpScope } from "@contract/domains/mcp";
import { useI18n } from "./I18nProvider";
import { apiJson } from "./apiJson";
import { McpResourceBrowser } from "./McpResourceBrowser";
import { ErrorNotice } from "./ErrorNotice";

export interface McpConfigContentProps {
  cwd?: string;
}

interface ProbeSummary {
  success: boolean;
  message?: string;
  toolsCount?: number;
  authRequired?: boolean;
}

const EXPOSURE_VALUES = ["deferred", "codemode", "direct", "hidden"] as const;
type Exposure = (typeof EXPOSURE_VALUES)[number];
type ConfiguredExposure = NonNullable<McpServerConfig["exposure"]>;

/** Older configs may use `codemode-deferred`; the UI collapses it to `codemode`. */
function normalizeExposure(value: ConfiguredExposure | undefined): Exposure {
  return EXPOSURE_VALUES.includes(value as Exposure) ? (value as Exposure) : "codemode";
}

function serverKey(server: { scope: string; id: string }): string {
  return `${server.scope}:${server.id}`;
}

/** OAuth applies to HTTP servers that do not send an Authorization header. */
function usesOAuth(server: McpServerStatus): boolean {
  if (server.transport === "stdio" || !server.url) return false;
  return !Object.keys(server.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

export function McpConfigContent({ cwd }: McpConfigContentProps) {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [editingServer, setEditingServer] = useState<Partial<McpServerStatus> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [formScope, setFormScope] = useState<"global" | "project">("project");
  const [formTransport, setFormTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [formId, setFormId] = useState("");
  const [formName, setFormName] = useState("");
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [formEnv, setFormEnv] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formHeaders, setFormHeaders] = useState("");
  const [formExposure, setFormExposure] = useState<Exposure>("deferred");

  // Live connection state (host-owned)
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingForm, setTestingForm] = useState(false);
  const [authStates, setAuthStates] = useState<Record<string, McpAuthState>>({});
  const [reports, setReports] = useState<Record<string, ProbeSummary>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [resourceServer, setResourceServer] = useState<McpServerStatus | null>(null);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message?: string;
    toolsCount?: number;
  } | null>(null);

  const loginTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const authUrlFor = useCallback(
    (server: { id: string; scope: McpScope }) =>
      `/api/mcp/auth?id=${encodeURIComponent(server.id)}&scope=${server.scope}${
        cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""
      }`,
    [cwd],
  );

  const loadServers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = cwd ? `/api/mcp?cwd=${encodeURIComponent(cwd)}` : "/api/mcp";
      const data = await apiJson<{ servers?: McpServerStatus[] }>(url, undefined, {
        fallback: t("mcp.loadFailed"),
      });
      const list = data.servers || [];
      setServers(list);

      const withOAuth = list.filter(usesOAuth);
      if (withOAuth.length > 0) {
        const entries = await Promise.all(
          withOAuth.map(async (server) => {
            try {
              const auth = await apiJson<McpAuthState>(authUrlFor(server), undefined, {
                fallback: t("mcp.authLoadFailed"),
              });
              return [serverKey(server), auth] as const;
            } catch {
              // Host down: the configuration list still renders.
              return null;
            }
          }),
        );
        setAuthStates((prev) => {
          const next = { ...prev };
          for (const entry of entries) {
            if (entry) next[entry[0]] = entry[1];
          }
          return next;
        });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("mcp.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [authUrlFor, cwd, t]);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  useEffect(
    () => () => {
      for (const timer of loginTimers.current.values()) clearTimeout(timer);
      loginTimers.current.clear();
    },
    [],
  );

  /** Poll the host while a browser sign-in is outstanding. */
  const pollLogin = useCallback(
    (server: McpServerStatus, loginId: string) => {
      if (loginTimers.current.has(loginId)) return;
      const started = Date.now();
      const tick = async () => {
        if (Date.now() - started > 5 * 60_000) {
          loginTimers.current.delete(loginId);
          return;
        }
        try {
          const auth = await apiJson<McpAuthState>(authUrlFor(server), undefined, {
            fallback: t("mcp.authLoadFailed"),
          });
          setAuthStates((prev) => ({ ...prev, [serverKey(server)]: auth }));
          const login = auth.login;
          if (login && login.loginId === loginId && login.status === "pending") {
            loginTimers.current.set(loginId, setTimeout(() => void tick(), 1500));
            return;
          }
          loginTimers.current.delete(loginId);
          if (!login || login.loginId !== loginId) return;
          if (login.status === "authorized") {
            setTestResult({ success: true, message: t("mcp.loginSucceeded", { name: server.name || server.id }) });
            void loadServers();
          } else if (login.status === "cancelled") {
            setTestResult({ success: false, message: t("mcp.loginCancelled") });
          } else {
            setTestResult({ success: false, message: login.message || t("mcp.loginFailed") });
          }
        } catch {
          loginTimers.current.delete(loginId);
        }
      };
      void tick();
    },
    [authUrlFor, loadServers, t],
  );

  // Resume polling after reopening the modal while a sign-in is outstanding.
  useEffect(() => {
    for (const server of servers) {
      const login = authStates[serverKey(server)]?.login;
      if (login?.status === "pending") pollLogin(server, login.loginId);
    }
  }, [authStates, pollLogin, servers]);

  const updateAuthState = (server: McpServerStatus, auth: McpAuthState) => {
    setAuthStates((prev) => ({ ...prev, [serverKey(server)]: auth }));
  };

  const handleToggle = async (server: McpServerStatus) => {
    try {
      await apiJson("/api/mcp/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: server.id,
          scope: server.scope,
          disabled: !server.disabled,
          cwd,
        }),
      }, { fallback: t("mcp.toggleFailed") });
      loadServers();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("mcp.toggleFailed"));
    }
  };

  const handleDelete = async (server: McpServerStatus) => {
    if (!confirm(t("mcp.deleteConfirm", { name: server.name || server.id }))) return;
    try {
      await apiJson("/api/mcp", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: server.id,
          scope: server.scope,
          cwd,
        }),
      }, { fallback: t("mcp.deleteFailed") });
      loadServers();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("mcp.deleteFailed"));
    }
  };

  const handleTestServer = async (server: McpServerStatus) => {
    const key = serverKey(server);
    setTestingId(key);
    setTestResult(null);
    try {
      const res = await fetch("/api/mcp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: server.id, scope: server.scope, cwd }),
      });
      const data = await res.json();
      const report: ProbeSummary = {
        success: data.success ?? false,
        message: data.message,
        toolsCount: data.toolsCount,
        authRequired: data.authRequired ?? false,
      };
      setReports((prev) => ({ ...prev, [key]: report }));
      setTestResult({
        success: report.success,
        message:
          report.message ||
          (report.success
            ? t("mcp.connectedTools", { count: report.toolsCount ?? 0 })
            : t("mcp.connectionFailed")),
        toolsCount: report.toolsCount,
      });
    } catch (err: unknown) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : t("mcp.testRequestFailed"),
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleTestFormServer = async () => {
    setTestingForm(true);
    setTestResult(null);
    try {
      let parsedEnv: Record<string, string> | undefined;
      if (formEnv.trim()) {
        parsedEnv = {};
        for (const line of formEnv.split("\n")) {
          const eqIndex = line.indexOf("=");
          if (eqIndex > 0) {
            const k = line.slice(0, eqIndex).trim();
            const v = line.slice(eqIndex + 1).trim();
            if (k) parsedEnv[k] = v;
          }
        }
      }

      const res = await fetch("/api/mcp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connection: {
            command: formTransport === "stdio" ? formCommand.trim() : undefined,
            args: formTransport === "stdio" ? formArgs.split(/\s+/).filter(Boolean) : undefined,
            env: parsedEnv,
            url: formTransport !== "stdio" ? formUrl.trim() : undefined,
            transport: formTransport,
            headers: formHeaders.trim() ? JSON.parse(formHeaders) : undefined,
          },
          cwd,
        }),
      });
      const data = await res.json();
      setTestResult({
        success: data.success ?? false,
        message: data.message || (data.success
          ? t("mcp.connectionSucceeded", { count: data.toolsCount ?? 0 })
          : t("mcp.connectionFailed")),
        toolsCount: data.toolsCount,
      });
    } catch (err: unknown) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : t("mcp.connectionTestFailed"),
      });
    } finally {
      setTestingForm(false);
    }
  };

  const postAuthAction = async (
    server: McpServerStatus,
    body: Record<string, unknown>,
  ): Promise<McpAuthState | null> => {
    return apiJson<McpAuthState>(authUrlFor(server), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, id: server.id, scope: server.scope, cwd }),
    }, { fallback: t("mcp.authFailed") });
  };

  const handleLogin = async (server: McpServerStatus) => {
    const key = serverKey(server);
    setBusyAction(key);
    setTestResult(null);
    try {
      const login = await apiJson<{ loginId: string; authorizationUrl: string }>(
        "/api/mcp/auth",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "login", id: server.id, scope: server.scope, cwd }),
        },
        { fallback: t("mcp.loginFailed") },
      );
      window.open(login.authorizationUrl, "_blank", "noopener,noreferrer");
      setTestResult({ success: true, message: t("mcp.loginStarted") });
      setAuthStates((prev) => ({
        ...prev,
        [key]: {
          ...(prev[key] ?? { oauth: true, authenticated: false, hasClient: false, hasRefreshToken: false }),
          login: {
            loginId: login.loginId,
            serverId: server.id,
            scope: server.scope,
            status: "pending",
            authorizationUrl: login.authorizationUrl,
            startedAt: Date.now(),
          },
        },
      }));
      pollLogin(server, login.loginId);
    } catch (err: unknown) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : t("mcp.loginFailed") });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancelLogin = async (server: McpServerStatus) => {
    const login = authStates[serverKey(server)]?.login;
    if (!login || login.status !== "pending") return;
    try {
      await apiJson("/api/mcp/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", loginId: login.loginId }),
      }, { fallback: t("mcp.loginCancelFailed") });
      setTestResult({ success: false, message: t("mcp.loginCancelled") });
      void loadServers();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("mcp.loginCancelFailed"));
    }
  };

  const handleLogout = async (server: McpServerStatus) => {
    const key = serverKey(server);
    setBusyAction(key);
    try {
      await postAuthAction(server, { action: "logout" });
      setReports((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setTestResult({ success: true, message: t("mcp.logoutSucceeded") });
      void loadServers();
    } catch (err: unknown) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : t("mcp.logoutFailed") });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRefreshAuth = async (server: McpServerStatus) => {
    const key = serverKey(server);
    setBusyAction(key);
    try {
      const auth = await postAuthAction(server, { action: "refresh" });
      if (auth) updateAuthState(server, auth);
      setTestResult({ success: true, message: t("mcp.refreshSucceeded") });
    } catch (err: unknown) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : t("mcp.refreshFailed") });
    } finally {
      setBusyAction(null);
    }
  };

  const openAddForm = () => {
    setIsNew(true);
    setEditingServer({});
    setFormScope(cwd ? "project" : "global");
    setFormTransport("stdio");
    setFormId("");
    setFormName("");
    setFormCommand("");
    setFormArgs("");
    setFormEnv("");
    setFormUrl("");
    setFormHeaders("");
    setFormExposure("deferred");
    setTestResult(null);
  };

  const openEditForm = (server: McpServerStatus) => {
    setIsNew(false);
    setEditingServer(server);
    setFormScope(server.scope);
    setFormTransport(server.transport || "stdio");
    setFormId(server.id);
    setFormName(server.name || "");
    setFormCommand(server.command || "");
    setFormArgs((server.args || []).join(" "));
    setFormEnv(
      server.env
        ? Object.entries(server.env)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")
        : ""
    );
    setFormUrl(server.url || "");
    setFormHeaders(server.headers ? JSON.stringify(server.headers, null, 2) : "");
    setFormExposure(normalizeExposure(server.exposure));
    setTestResult(null);
  };

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formId.trim()) {
      setError(t("mcp.serverIdRequired"));
      return;
    }

    let parsedEnv: Record<string, string> | undefined;
    if (formEnv.trim()) {
      parsedEnv = {};
      for (const line of formEnv.split("\n")) {
        const eqIndex = line.indexOf("=");
        if (eqIndex > 0) {
          const k = line.slice(0, eqIndex).trim();
          const v = line.slice(eqIndex + 1).trim();
          if (k) parsedEnv[k] = v;
        }
      }
    }

    const serverConfig: McpServerConfig = {
      id: formId.trim(),
      name: formName.trim() || undefined,
      transport: formTransport,
      command: formTransport === "stdio" ? formCommand.trim() || undefined : undefined,
      args: formTransport === "stdio" ? formArgs.split(/\s+/).filter(Boolean) : undefined,
      env: formTransport === "stdio" ? parsedEnv ?? {} : undefined,
      url: formTransport !== "stdio" ? formUrl.trim() || undefined : undefined,
      exposure: formExposure,
      disabled: editingServer?.disabled ?? false,
    };

    try {
      serverConfig.headers = formTransport === "http" ? (formHeaders.trim() ? JSON.parse(formHeaders) : {}) : undefined;
      await apiJson("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: formScope,
          cwd,
          server: serverConfig,
        }),
      }, { fallback: t("mcp.saveFailed") });
      setEditingServer(null);
      loadServers();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("mcp.saveFailed"));
    }
  };

  if (resourceServer) {
    return (
      <McpResourceBrowser
        serverId={resourceServer.id}
        scope={resourceServer.scope}
        cwd={cwd}
        onClose={() => setResourceServer(null)}
      />
    );
  }

  return (
    <div className="flex flex-col h-full bg-bg text-text text-[13px]">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-divider bg-bg-elevated shrink-0">
        <div>
          <h3 className="font-semibold text-text text-[14px]">{t("mcp.servers")}</h3>
          <p className="text-[11px] text-text-muted">
            {t("mcp.description")}
          </p>
        </div>
        {!editingServer && (
          <button
            onClick={openAddForm}
            className="px-3 py-1.5 rounded-control bg-accent text-accent-contrast font-medium hover:opacity-90 transition-opacity cursor-pointer text-[12px]"
          >
            {t("mcp.addServer")}
          </button>
        )}
      </div>

      {error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-control bg-red-500/10 border border-red-500/20 text-red-400 text-[12px] flex items-center justify-between">
          <ErrorNotice message={error} className="min-w-0 flex-1 break-words" />
          <button onClick={() => setError(null)} className="text-red-400 font-bold ml-2">
            ×
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-4">
        <p className="mb-4 text-[12px] leading-relaxed text-text-muted">{t("mcp.nativeHint")}</p>
        {editingServer ? (
          /* Add / Edit Form */
          <form onSubmit={handleSaveForm} className="flex flex-col gap-3 max-w-xl mx-auto bg-bg-panel p-4 rounded-panel border border-border">
            <h4 className="font-semibold text-text text-[13px] border-b border-divider pb-2">
              {isNew ? t("mcp.addTitle") : t("mcp.editTitle", { id: editingServer.id ?? "" })}
            </h4>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-text-muted mb-1">
                  {t("mcp.serverId")}
                </label>
                <input
                  type="text"
                  value={formId}
                  onChange={(e) => setFormId(e.target.value)}
                  disabled={!isNew}
                  placeholder="e.g. github"
                  className="w-full px-2.5 py-1.5 rounded-control bg-bg border border-border text-text font-mono text-[12px] focus:outline-none focus:border-accent disabled:opacity-50"
                  required
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-text-muted mb-1">
                  {t("mcp.displayName")}
                </label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. GitHub MCP"
                  className="w-full px-2.5 py-1.5 rounded-control bg-bg border border-border text-text text-[12px] focus:outline-none focus:border-accent"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-text-muted mb-1">
                  {t("mcp.scope")}
                </label>
                <select
                  value={formScope}
                  onChange={(e) => setFormScope(e.target.value as "global" | "project")}
                  className="w-full px-2.5 py-1.5 rounded-control bg-bg border border-border text-text text-[12px] focus:outline-none focus:border-accent"
                >
                  <option value="project">{t("scope.project")} (.pi/mcp.json)</option>
                  <option value="global">{t("scope.global")} (~/.pi/agent/mcp.json)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-text-muted mb-1">
                  {t("mcp.transport")}
                </label>
                <select
                  value={formTransport}
                  onChange={(e) => setFormTransport(e.target.value as "stdio" | "http" | "sse")}
                  className="w-full px-2.5 py-1.5 rounded-control bg-bg border border-border text-text text-[12px] focus:outline-none focus:border-accent"
                >
                  <option value="stdio">{t("mcp.stdioTransport")}</option>
                  <option value="http">{t("mcp.httpTransport")}</option>
                  {formTransport === "sse" && <option value="sse" disabled>{t("mcp.sseTransport")}</option>}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-text-muted mb-1">
                {t("mcp.exposure")}
              </label>
              <select
                value={formExposure}
                onChange={(e) => setFormExposure(e.target.value as Exposure)}
                className="w-full px-2.5 py-1.5 rounded-control bg-bg border border-border text-text text-[12px]"
              >
                {EXPOSURE_VALUES.map((value) => (
                  <option key={value} value={value}>{t(`mcp.exposure.${value}`)}</option>
                ))}
              </select>
              <p className="mt-1 text-[11px] leading-relaxed text-text-dim">{t("mcp.exposureHint")}</p>
            </div>

            {formTransport === "stdio" ? (
              <>
                <div>
                  <label className="block text-[11px] font-medium text-text-muted mb-1">
                    {t("mcp.command")}
                  </label>
                  <input
                    type="text"
                    value={formCommand}
                    onChange={(e) => setFormCommand(e.target.value)}
                    placeholder="e.g. npx or node"
                    className="w-full px-2.5 py-1.5 rounded-control bg-bg border border-border text-text font-mono text-[12px] focus:outline-none focus:border-accent"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-text-muted mb-1">
                    {t("mcp.arguments")}
                  </label>
                  <input
                    type="text"
                    value={formArgs}
                    onChange={(e) => setFormArgs(e.target.value)}
                    placeholder="e.g. -y @modelcontextprotocol/server-github"
                    className="w-full px-2.5 py-1.5 rounded-control bg-bg border border-border text-text font-mono text-[12px] focus:outline-none focus:border-accent"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-text-muted mb-1">
                    {t("mcp.environment")}
                  </label>
                  <textarea
                    value={formEnv}
                    onChange={(e) => setFormEnv(e.target.value)}
                    rows={3}
                    placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_..."
                    className="w-full px-2.5 py-1.5 rounded-control bg-bg border border-border text-text font-mono text-[12px] focus:outline-none focus:border-accent resize-y"
                  />
                </div>
              </>
            ) : (
              <div>
                <label className="block text-[11px] font-medium text-text-muted mb-1">
                  {t("mcp.endpoint")}
                </label>
                <input
                  type="url"
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  placeholder="https://mcp-server.example.com/mcp"
                  className="w-full px-2.5 py-1.5 rounded-control bg-bg border border-border text-text font-mono text-[12px] focus:outline-none focus:border-accent"
                />
                <label className="block mt-3 text-[12px] text-text-muted">
                  {t("mcp.headers")}
                  <textarea value={formHeaders} onChange={(e) => setFormHeaders(e.target.value)} rows={3}
                    placeholder={'{"Authorization": "Bearer ${TOKEN}"}'}
                    className="block mt-1 w-full px-2.5 py-1.5 rounded-control bg-bg border border-border text-text font-mono resize-y" />
                </label>
                <p className="mt-1 text-[11px] leading-relaxed text-text-dim">{t("mcp.oauthHint")}</p>
              </div>
            )}

            {/* Test connection output in form */}
            {testResult && (
              <div
                className={`p-2.5 rounded-control text-[12px] border ${
                  testResult.success
                    ? "bg-green-500/10 border-green-500/20 text-green-400"
                    : "bg-red-500/10 border-red-500/20 text-red-400"
                }`}
              >
                {testResult.message}
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-divider mt-2">
              <button
                type="button"
                onClick={handleTestFormServer}
                disabled={testingForm}
                className="px-3 py-1.5 rounded-control border border-border text-text-muted hover:text-text hover:bg-bg-hover transition-colors cursor-pointer text-[12px] disabled:opacity-50"
              >
                {testingForm ? t("mcp.testing") : t("mcp.testConnection")}
              </button>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingServer(null);
                    setTestResult(null);
                  }}
                  className="px-3 py-1.5 rounded-control border border-border text-text-muted hover:text-text hover:bg-bg-hover transition-colors cursor-pointer text-[12px]"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-control bg-accent text-accent-contrast font-medium hover:opacity-90 transition-opacity cursor-pointer text-[12px]"
                >
                  {t("mcp.saveServer")}
                </button>
              </div>
            </div>
          </form>
        ) : loading ? (
          <div className="flex items-center justify-center h-40 text-text-muted text-[13px]">
            {t("mcp.loading")}
          </div>
        ) : servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-text-muted gap-2 border border-dashed border-border rounded-panel p-6">
            <span className="text-[14px]">{t("mcp.none")}</span>
            <p className="text-[12px] text-text-dim text-center max-w-sm">
              {t("mcp.noneHint")}
            </p>
            <button
              onClick={openAddForm}
              className="mt-2 px-3 py-1.5 rounded-control bg-accent text-accent-contrast text-[12px] font-medium hover:opacity-90"
            >
              {t("mcp.addFirst")}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {testResult && (
              <div
                className={`p-2.5 rounded-control text-[12px] border ${
                  testResult.success
                    ? "bg-green-500/10 border-green-500/20 text-green-400"
                    : "bg-red-500/10 border-red-500/20 text-red-400"
                }`}
              >
                {testResult.message}
              </div>
            )}

            {servers.map((server) => {
              const key = serverKey(server);
              const isTesting = testingId === key;
              const isBusy = busyAction === key;
              const isDisabled = Boolean(server.disabled);
              const auth = authStates[key];
              const report = reports[key];
              const login = auth?.login;
              const loginPending = login?.status === "pending";
              const oauthCapable = usesOAuth(server);
              const needsLogin = oauthCapable && !auth?.authenticated && !loginPending;
              const exposure = normalizeExposure(server.exposure);
              const statusLabel = isDisabled
                ? t("common.disabled")
                : loginPending
                  ? t("mcp.waitingAuthorization")
                  : needsLogin
                    ? t("mcp.needsLogin")
                    : report?.success
                      ? `${t("common.connected")}${report.toolsCount ? ` (${t("common.toolsCount", { count: report.toolsCount })})` : ""}`
                      : auth?.authenticated
                        ? t("mcp.authorized")
                        : server.status === "error"
                          ? t("common.error")
                          : t("mcp.configured");

              return (
                <div
                  key={key}
                  className={`flex flex-col gap-2 p-3.5 rounded-panel border transition-[background-color,border-color,color] duration-150 ${
                    isDisabled
                      ? "bg-bg-panel/40 border-border/50 opacity-65"
                      : "bg-bg-panel border-border"
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                    <div className="flex flex-col gap-1 pr-2 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-text text-[13px]">
                          {server.name || server.id}
                        </span>
                        {server.name && (
                          <span className="font-mono text-[11px] text-text-dim">
                            ({server.id})
                          </span>
                        )}

                        {/* Scope Badge */}
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-mono border uppercase tracking-wider ${
                            server.scope === "global"
                              ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/20"
                              : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                          }`}
                        >
                          {t(server.scope === "global" ? "scope.global" : "scope.project")}
                        </span>

                        {/* Transport Badge */}
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-bg-elevated text-text-dim border border-border">
                          {server.transport || "stdio"}
                        </span>

                        {/* Exposure badge */}
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-bg-elevated text-text-dim border border-border">
                          {t(`mcp.exposure.${exposure}`)}
                        </span>

                        {/* Status Badge */}
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-medium border flex items-center gap-1 ${
                            isDisabled
                              ? "bg-gray-500/10 text-gray-400 border-gray-500/20"
                              : loginPending || needsLogin
                                ? "bg-amber-500/10 text-amber-600 border-amber-500/20"
                                : report?.success || auth?.authenticated
                                  ? "bg-green-500/10 text-green-600 border-green-500/20"
                                  : server.status === "error"
                                    ? "bg-red-500/10 text-red-500 border-red-500/20"
                                    : "bg-gray-500/10 text-gray-500 border-gray-500/20"
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              isDisabled
                                ? "bg-gray-400"
                                : loginPending || needsLogin
                                  ? "bg-amber-400"
                                  : report?.success || auth?.authenticated
                                    ? "bg-green-400"
                                    : server.status === "error"
                                      ? "bg-red-400"
                                      : "bg-gray-400"
                            }`}
                          />
                          {statusLabel}
                        </span>
                      </div>

                      {/* Command / URL details */}
                      <div className="font-mono text-[11px] text-text-muted truncate max-w-lg mt-0.5">
                        {server.transport !== "stdio" ? (
                          <span>{server.url}</span>
                        ) : (
                          <span>
                            {server.command} {(server.args || []).join(" ")}
                          </span>
                        )}
                      </div>

                      {loginPending && login?.authorizationUrl && (
                        <div className="mt-1 flex flex-col gap-1 rounded-control border border-amber-200 bg-amber-50 px-2.5 py-1.5">
                          <p className="text-[11px] text-amber-700">{t("mcp.waitingAuthorizationHint")}</p>
                          <a
                            href={login.authorizationUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="truncate text-[11px] text-accent underline"
                          >
                            {t("mcp.reopenAuthorization")}
                          </a>
                        </div>
                      )}

                      {server.errorMessage && !isDisabled && (
                        <div className="text-[11px] text-red-400 mt-1">
                          {server.errorMessage}
                        </div>
                      )}
                      {!isDisabled && report && !report.success && report.message && (
                        <div className="text-[11px] text-red-500 mt-1">
                          {report.authRequired ? t("mcp.authRequiredHint") : report.message}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleTestServer(server)}
                        disabled={isTesting || isDisabled}
                        className="px-2.5 py-1 rounded-control border border-border text-text-muted hover:text-text hover:bg-bg-hover transition-colors text-[11px] disabled:opacity-40 cursor-pointer"
                      >
                        {isTesting ? t("mcp.testing") : t("common.test")}
                      </button>
                      <button
                        onClick={() => setResourceServer(server)}
                        disabled={isDisabled}
                        className="px-2.5 py-1 rounded-control border border-border text-text-muted hover:text-text hover:bg-bg-hover transition-colors text-[11px] disabled:opacity-40 cursor-pointer"
                      >
                        {t("mcp.resources")}
                      </button>
                      {oauthCapable && !isDisabled && (loginPending ? (
                        <button
                          onClick={() => handleCancelLogin(server)}
                          className="px-2.5 py-1 rounded-control border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors text-[11px] cursor-pointer"
                        >
                          {t("mcp.cancelLogin")}
                        </button>
                      ) : auth?.authenticated ? (
                        <>
                          <button
                            onClick={() => handleRefreshAuth(server)}
                            disabled={isBusy}
                            className="px-2.5 py-1 rounded-control border border-border text-text-muted hover:text-text hover:bg-bg-hover transition-colors text-[11px] disabled:opacity-40 cursor-pointer"
                          >
                            {t("mcp.refreshAuth")}
                          </button>
                          <button
                            onClick={() => handleLogout(server)}
                            disabled={isBusy}
                            className="px-2.5 py-1 rounded-control border border-border text-text-muted hover:text-text hover:bg-bg-hover transition-colors text-[11px] disabled:opacity-40 cursor-pointer"
                          >
                            {t("mcp.logout")}
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => handleLogin(server)}
                          disabled={isBusy}
                          className="px-2.5 py-1 rounded-control bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20 transition-colors text-[11px] font-medium disabled:opacity-40 cursor-pointer"
                        >
                          {t("mcp.login")}
                        </button>
                      ))}
                      <button
                        onClick={() => handleToggle(server)}
                        className={`px-2.5 py-1 rounded-control text-[11px] font-medium transition-colors cursor-pointer border ${
                          isDisabled
                            ? "bg-accent/10 text-accent border-accent/30 hover:bg-accent/20"
                            : "bg-bg-elevated text-text-muted border-border hover:text-text"
                        }`}
                      >
                        {isDisabled ? t("common.enable") : t("common.disable")}
                      </button>
                      <button
                        onClick={() => openEditForm(server)}
                        className="px-2.5 py-1 rounded-control border border-border text-text-muted hover:text-text hover:bg-bg-hover transition-colors text-[11px] cursor-pointer"
                      >
                        {t("common.edit")}
                      </button>
                      <button
                        onClick={() => handleDelete(server)}
                        className="px-2.5 py-1 rounded-control border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors text-[11px] cursor-pointer"
                      >
                        {t("common.delete")}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
