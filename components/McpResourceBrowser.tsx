"use client";

import React, { useCallback, useEffect, useState } from "react";
import { ArrowLeft, FileText, RefreshCw } from "lucide-react";
import type {
  McpResourceReadResult,
  McpResourceSummary,
  McpResourceTemplateSummary,
} from "@contract/domains/mcp";
import { apiJson } from "./apiJson";
import { useI18n } from "./I18nProvider";

export interface McpResourceBrowserProps {
  serverId: string;
  scope: "global" | "project";
  cwd?: string;
  onClose: () => void;
}

interface ResourceListResponse {
  toolsCount: number;
  resources: McpResourceSummary[];
  resourceTemplates: McpResourceTemplateSummary[];
}

function formatBytes(size?: number): string | undefined {
  if (size === undefined || !Number.isFinite(size)) return undefined;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * MCP resource browser. Listing and reading happen in the Agent Host; this
 * component only renders the DTOs it receives.
 */
export function McpResourceBrowser({ serverId, scope, cwd, onClose }: McpResourceBrowserProps) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ResourceListResponse | null>(null);
  const [activeUri, setActiveUri] = useState<string | null>(null);
  const [uriInput, setUriInput] = useState("");
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<McpResourceReadResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const listUrl = `/api/mcp/resources?id=${encodeURIComponent(serverId)}&scope=${scope}${
    cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""
  }`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiJson<ResourceListResponse>(listUrl, undefined, {
        fallback: t("mcp.resourcesLoadFailed"),
      });
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("mcp.resourcesLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [listUrl, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const read = useCallback(
    async (uri: string) => {
      const trimmed = uri.trim();
      if (!trimmed) return;
      setActiveUri(trimmed);
      setPreview(null);
      setPreviewError(null);
      setReading(true);
      try {
        const result = await apiJson<McpResourceReadResult>(
          "/api/mcp/resources/read",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: serverId, scope, cwd, uri: trimmed }),
          },
          { fallback: t("mcp.resourceReadFailed") },
        );
        setPreview(result);
      } catch (err: unknown) {
        setPreviewError(err instanceof Error ? err.message : t("mcp.resourceReadFailed"));
      } finally {
        setReading(false);
      }
    },
    [cwd, scope, serverId, t],
  );

  const resources = data?.resources ?? [];
  const templates = data?.resourceTemplates ?? [];
  const empty = resources.length === 0 && templates.length === 0;

  return (
    <div className="flex h-full flex-col bg-bg text-text text-[13px]">
      <div className="flex shrink-0 items-center justify-between border-b border-divider bg-bg-elevated px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-control border border-border text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
            aria-label={t("common.back")}
            title={t("common.back")}
          >
            <ArrowLeft size={14} strokeWidth={1.75} />
          </button>
          <div>
            <h3 className="text-[13px] font-semibold text-text">{t("mcp.resourcesTitle", { id: serverId })}</h3>
            <p className="text-[11px] text-text-muted">{t("mcp.resourcesHint")}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-control border border-border px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text disabled:opacity-50"
        >
          <RefreshCw size={12} strokeWidth={1.75} />
          {t("common.refresh")}
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-3 rounded-control border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-600">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="w-[240px] shrink-0 overflow-y-auto border-r border-divider p-2">
          {loading ? (
            <div className="py-8 text-center text-[12px] text-text-muted">{t("mcp.resourcesLoading")}</div>
          ) : empty ? (
            <div className="px-2 py-8 text-center text-[12px] text-text-muted">{t("mcp.noResources")}</div>
          ) : (
            <>
              {resources.length > 0 && (
                <div className="mb-2">
                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-text-dim">
                    {t("mcp.resourcesSection")} · {resources.length}
                  </div>
                  {resources.map((resource) => (
                    <button
                      key={resource.uri}
                      type="button"
                      onClick={() => void read(resource.uri)}
                      className={`flex w-full flex-col gap-0.5 rounded-control px-2 py-1.5 text-left transition-colors ${
                        activeUri === resource.uri ? "bg-[#E8EFFB] text-accent" : "text-text hover:bg-bg-hover"
                      }`}
                    >
                      <span className="truncate text-[12px] font-medium">
                        {resource.title || resource.name || resource.uri}
                      </span>
                      <span className="truncate font-mono text-[10px] text-text-dim">{resource.uri}</span>
                      {(resource.mimeType || resource.size !== undefined) && (
                        <span className="truncate text-[10px] text-text-dim">
                          {[resource.mimeType, formatBytes(resource.size)].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {templates.length > 0 && (
                <div>
                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-text-dim">
                    {t("mcp.resourceTemplatesSection")} · {templates.length}
                  </div>
                  {templates.map((template) => (
                    <button
                      key={template.uriTemplate}
                      type="button"
                      onClick={() => setUriInput(template.uriTemplate)}
                      className="flex w-full flex-col gap-0.5 rounded-control px-2 py-1.5 text-left text-text transition-colors hover:bg-bg-hover"
                    >
                      <span className="truncate text-[12px] font-medium">
                        {template.title || template.name || template.uriTemplate}
                      </span>
                      <span className="truncate font-mono text-[10px] text-text-dim">{template.uriTemplate}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-divider px-3 py-2">
            <input
              type="text"
              value={uriInput}
              onChange={(event) => setUriInput(event.target.value)}
              placeholder="scheme://path"
              className="min-w-0 flex-1 rounded-control border border-border bg-bg px-2.5 py-1.5 font-mono text-[12px] text-text focus:border-accent focus:outline-none"
              onKeyDown={(event) => {
                if (event.key === "Enter") void read(uriInput);
              }}
            />
            <button
              type="button"
              onClick={() => void read(uriInput)}
              disabled={reading || !uriInput.trim()}
              className="shrink-0 rounded-control bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-contrast transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {reading ? t("mcp.resourceReading") : t("mcp.resourceRead")}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {previewError ? (
              <div className="rounded-control border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-600">
                {previewError}
              </div>
            ) : reading ? (
              <div className="py-10 text-center text-[12px] text-text-muted">{t("mcp.resourceReading")}</div>
            ) : !preview ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-text-muted">
                <FileText size={20} strokeWidth={1.5} />
                <p className="text-[12px]">{t("mcp.resourcePreviewHint")}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {preview.truncated && (
                  <div className="rounded-control border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700">
                    {t("mcp.resourceTruncated")}
                  </div>
                )}
                {preview.contents.map((content, index) => (
                  <div key={`${content.uri}-${index}`} className="overflow-hidden rounded-panel border border-border">
                    <div className="flex items-center justify-between gap-2 border-b border-divider bg-bg-elevated px-3 py-1.5">
                      <span className="truncate font-mono text-[11px] text-text-muted">{content.uri}</span>
                      {content.mimeType && (
                        <span className="shrink-0 font-mono text-[10px] text-text-dim">{content.mimeType}</span>
                      )}
                    </div>
                    {content.text !== undefined ? (
                      <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-relaxed text-text">
                        {content.text}
                      </pre>
                    ) : (
                      <div className="px-3 py-3 text-[12px] text-text-muted">
                        {t("mcp.resourceBinary", { bytes: content.blobBase64?.length ?? 0 })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default McpResourceBrowser;
