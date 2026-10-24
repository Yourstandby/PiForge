"use client";

import { useEffect, useState } from "react";
import { apiJson } from "./apiJson";
import { useI18n } from "./I18nProvider";
import { ErrorNotice } from "./ErrorNotice";

type CodemodeMode = "on" | "only";

const MODES: CodemodeMode[] = ["on", "only"];

export function CodemodeConfig() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<CodemodeMode>("only");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiJson<{ codemodeEnabled?: boolean; codemodeMode?: CodemodeMode }>("/api/desktop-settings", undefined, { fallback: t("codemode.loadFailed") })
      .then((settings) => {
        if (cancelled) return;
        setEnabled(settings.codemodeEnabled ?? false);
        setMode(settings.codemodeMode === "on" ? "on" : "only");
        setLoaded(true);
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : t("codemode.loadFailed")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [t]);

  const save = async (patch: { codemodeEnabled?: boolean; codemodeMode?: CodemodeMode }) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await apiJson<{ codemodeEnabled: boolean; codemodeMode?: CodemodeMode }>("/api/desktop-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }, { fallback: t("codemode.saveFailed") });
      setEnabled(saved.codemodeEnabled);
      setMode(saved.codemodeMode === "on" ? "on" : "only");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("codemode.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const toggle = () => save({ codemodeEnabled: !enabled });

  return (
    <div className="p-4 flex flex-col gap-4 text-[13px]">
      <section className="p-4 rounded-panel border border-border bg-bg-panel">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h4 id="codemode-label" className="font-semibold text-text">{t("codemode.title")}</h4>
            <p className="mt-1 text-text-muted text-[12px]">{t("codemode.subtitle")}</p>
          </div>
          <button type="button" role="switch" aria-checked={enabled} aria-labelledby="codemode-label"
            aria-describedby="codemode-timing" disabled={!loaded || loading || saving} onClick={toggle}
            className="min-h-11 min-w-20 shrink-0 px-3 rounded-control border border-border bg-bg-elevated text-text hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 disabled:cursor-wait">
            {loading ? t("common.loading") : saving ? t("codemode.saving") : enabled ? t("common.enabled") : t("common.disabled")}
          </button>
        </div>
        <p id="codemode-timing" className="mt-3 text-[12px] leading-relaxed text-text-muted">{t("codemode.timing")}</p>
        {error && <ErrorNotice className="mt-3 block text-red-400" message={error} />}
      </section>
      <section className="p-4 rounded-panel border border-border bg-bg-panel">
        <h4 id="codemode-mode-label" className="font-semibold text-text">{t("codemode.mode.title")}</h4>
        <div role="group" aria-labelledby="codemode-mode-label" className="mt-2 flex flex-wrap gap-1.5">
          {MODES.map((value) => {
            const active = mode === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                disabled={!loaded || loading || saving || !enabled}
                onClick={() => void save({ codemodeMode: value })}
                className={`min-h-9 rounded-control border px-3 text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${active
                  ? "border-[#BFD3F7] bg-[#E8EFFB] text-[#2563EB]"
                  : "border-border bg-bg-elevated text-text-muted hover:bg-bg-hover"}`}
              >
                {t(value === "on" ? "codemode.mode.on" : "codemode.mode.only")}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-text-muted">
          {t(mode === "on" ? "codemode.mode.onHint" : "codemode.mode.onlyHint")}
        </p>
      </section>
      <section className="p-4 rounded-panel border border-border leading-relaxed">
        <h4 className="font-semibold text-text">{t("codemode.what")}</h4>
        <p className="mt-2 text-text-muted">{t("codemode.description")}</p>
        <p className="mt-3 text-text-muted">{t("codemode.example")}</p>
        <p className="mt-3 text-text-muted">{t("codemode.permissions")}</p>
      </section>
    </div>
  );
}
