"use client";

import React, { useState, useRef } from "react";
import type { ModelOption } from "./types";
import { useI18n } from "../I18nProvider";
import { useDismissOnOutsideClick } from "@/hooks/useDismissOnOutsideClick";
import { Check, ChevronDown, Cpu } from "lucide-react";

interface ModelSelectorProps {
  isStreaming: boolean;
  model?: { provider: string; modelId: string } | null;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; input?: string[] }[];
  onModelChange?: (provider: string, modelId: string) => void;
  /** 底部工具栏收窄时只给模型名更小的宽度上限。 */
  compact?: boolean;
}

export function ModelSelector({
  isStreaming,
  model,
  modelNames,
  modelList,
  onModelChange,
  compact = false,
}: ModelSelectorProps) {
  const { t } = useI18n();
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);

  // Build model options: prefer modelList (has provider info), fallback to modelNames.
  // "Auto" is a desktop pseudo-model: the send path routes each prompt to the
  // fast or strong tier (lib/model-routing.ts).
  const modelOptions: ModelOption[] = (() => {
    const auto: ModelOption = { provider: "auto", modelId: "auto", name: "Auto" };
    if (modelList && modelList.length > 0) {
      return [auto, ...modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }))];
    }
    return [
      auto,
      ...Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
        provider: model?.provider ?? "unknown",
        modelId,
        name,
      })),
    ];
  })();

  // Group options by provider, preserving insertion order
  const modelsByProvider: { provider: string; options: ModelOption[] }[] = [];
  for (const opt of modelOptions) {
    const group = modelsByProvider.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else modelsByProvider.push({ provider: opt.provider, options: [opt] });
  }

  const currentName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name ?? model.modelId)
    : modelOptions.length > 0 ? modelOptions[0].name : null;

  useDismissOnOutsideClick(dropdownRef, modelDropdownOpen, () => setModelDropdownOpen(false));

  if (modelOptions.length === 0 || !currentName || !onModelChange) {
    return null;
  }

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <button
        onClick={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
          setModelDropdownOpen((v) => !v);
        }}
        disabled={isStreaming}
        title={currentName}
        aria-label={t("model.change", { model: currentName })}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: "auto", padding: "0 7px", gap: 5,
          height: "var(--control-height)",
          flexShrink: 0,
          background: modelDropdownOpen ? "var(--bg-hover)" : "none",
          border: "none",
          borderRadius: "var(--radius-control)",
          color: "var(--text-muted)",
          cursor: isStreaming ? "not-allowed" : "pointer",
          fontSize: 12,
          opacity: isStreaming ? 0.5 : 1,
        }}
        className={isStreaming ? "" : "hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:scale-95 transition-[background-color,color,transform] duration-150"}
      >
        <Cpu size={13} strokeWidth={1.75} aria-hidden="true" style={{ flexShrink: 0 }} />
        {/* 模型名在窄宽度下缩短并省略，不把底部工具栏撑爆 */}
        <span
          className={`min-w-0 truncate ${compact ? "max-w-[96px]" : "max-w-[150px]"}`}
        >
          {currentName}
        </span>
        <ChevronDown size={11} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0 }} />
      </button>
      {modelDropdownOpen && modelDropdownRect && (() => {
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const bottom = viewportHeight - modelDropdownRect.top + 6;
        const maxH = Math.max(120, Math.min(modelDropdownRect.top - 8, viewportHeight * 0.6));
        return (
          <div
            ref={modelDropdownPanelRef}
            className="t-dropdown is-open material-popover"
            data-origin="bottom-left"
            style={{
            position: "fixed",
            bottom, left: modelDropdownRect.left,
            zIndex: 500, background: "var(--material-popover)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-panel)", boxShadow: "var(--shadow-popover)",
            overflow: "hidden", width: "max-content", minWidth: modelDropdownRect.width, maxHeight: maxH, overflowY: "auto",
          }}>
            {modelsByProvider.map((group, gi) => (
              <div key={group.provider}>
                {(modelsByProvider.length > 1) && (
                  <div style={{
                    padding: "6px 12px 4px",
                    fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                    textTransform: "uppercase", letterSpacing: "0.07em",
                    borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                  }}>
                    {group.provider}
                  </div>
                )}
                {group.options.map((opt) => {
                  const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                  return (
                    <button
                      key={`${opt.provider}:${opt.modelId}`}
                      onClick={() => { setModelDropdownOpen(false); if (!isActive) onModelChange(opt.provider, opt.modelId); }}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        width: "100%", padding: "7px 12px",
                        background: isActive ? "var(--bg-selected)" : "none",
                        border: "none",
                        color: isActive ? "var(--text)" : "var(--text-muted)",
                        cursor: "pointer", fontSize: 12, textAlign: "left",
                        fontWeight: isActive ? 600 : 400,
                        whiteSpace: "nowrap",
                      }}
                      className={isActive ? "" : "hover:bg-[var(--bg-hover)] transition-colors duration-150"}
                    >
                      {isActive
                        ? <Check size={11} strokeWidth={2.4} style={{ flexShrink: 0, color: "var(--accent)" }} />
                        : <span style={{ width: 10, flexShrink: 0 }} />}
                      {opt.name}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}
