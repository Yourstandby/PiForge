"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ON_DEMAND_DOMAIN_OPTIONS,
  formatOnDemandSummary,
  isSettingsOverriddenByEnv,
  normalizeOnDemandSelection,
  onDemandWarning,
} from "@/lib/on-demand-settings-view";
import type { OnDemandSource } from "@/lib/domain-tools";
import { Settings2 } from "lucide-react";
import { ModalSurface } from "./ModalSurface";
import { useI18n } from "./I18nProvider";
import type { LocalePreference } from "@/lib/i18n";
import type { UpstreamVersionStatus } from "@/lib/upstream-version";
import { PiCoreVersionPicker } from "./PiCoreVersionPicker";
import {
  UI_SCALE_STORAGE_KEY,
  applyUiScale,
  readStoredUiScale,
} from "@/lib/ui-scale";
import {
  THEME_OPTIONS,
  applyTheme,
  readStoredTheme,
  saveThemePreference,
  type ThemePreference,
} from "@/lib/theme";

export { UI_SCALE_STORAGE_KEY, applyUiScale, readStoredUiScale };

const UI_SCALE_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: "小", value: 0.9 },
  { label: "标准", value: 1 },
  { label: "大", value: 1.1 },
];

const LOCALE_OPTIONS: ReadonlyArray<{
  label: string;
  value: LocalePreference;
}> = [
  { label: "跟随系统", value: "system" },
  { label: "简体中文", value: "zh-CN" },
  { label: "English", value: "en" },
];

const THINKING_OPTIONS = [
  { label: "关闭", value: "off" },
  { label: "低", value: "low" },
  { label: "中", value: "medium" },
  { label: "高", value: "high" },
];

const ENTER_OPTIONS = [
  { label: "立即打断并发送", value: "one-at-a-time" },
  { label: "排队等待", value: "all" },
];

const CACHE_WARMING_OPTIONS = [
  { label: "关闭", value: "off" },
  { label: "流式期间", value: "streaming" },
  { label: "空闲时保活", value: "idle" },
];

/** agent.state 上报的真实缓存保活状态（见 agent-host/cache-warming.ts）。 */
interface CacheWarmingStatusView {
  mode: string;
  state: string;
  reason?: string;
  prewarm?: { sent: boolean; reason: string };
}

export interface SettingsSnapshot {
  defaultThinkingLevel: string;
  steeringMode: string;
  followUpMode: string;
  hideThinkingBlock: boolean;
  showCacheMissNotices: boolean;
  compactionEnabled: boolean;
  retryEnabled: boolean;
  cacheWarming: string;
  showImages: boolean;
  enableSkillCommands: boolean;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] font-semibold text-ink">{children}</div>;
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <div className="text-[12.5px] text-ink">{label}</div>
        {hint && (
          <div className="mt-0.5 text-[11px] text-ink-faint">{hint}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: ReadonlyArray<{ label: string; value: T }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`rounded-lg border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-60 ${
            value === option.value
              ? "border-accent bg-[#E8EFFB] text-[#2563EB]"
              : "border-divider text-ink-muted hover:bg-[#F5F5F7] hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-[22px] w-[40px] shrink-0 rounded-full transition-colors ${
        checked ? "bg-[#2563EB]" : "bg-[#D7DBE3]"
      }`}
    >
      <span
        className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-all ${
          checked ? "left-[21px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}

interface GeneralSettingsModalProps {
  sessionId?: string | null;
  cwd?: string | null;
  onClose: () => void;
}

export function GeneralSettingsModal({
  sessionId,
  cwd,
  onClose,
}: GeneralSettingsModalProps) {
  const { preference, setPreference } = useI18n();
  const [scale, setScale] = useState(1);
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [cacheWarming, setCacheWarming] =
    useState<CacheWarmingStatusView | null>(null);
  /** 实际生效的按需域（环境变量 > 设置项 > 默认）与来源。 */
  const [onDemand, setOnDemand] = useState<{
    domains: string[];
    source: OnDemandSource;
    saved: string[];
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [upstream, setUpstream] = useState<UpstreamVersionStatus | null>(null);
  const [checkingUpstream, setCheckingUpstream] = useState(false);

  useEffect(() => {
    setScale(readStoredUiScale());
    setTheme(readStoredTheme());
    fetch("/api/settings")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: SettingsSnapshot | null) => {
        if (data) setSettings(data);
      })
      .catch(() => {});
  }, []);

  const loadUpstream = useCallback(async (force: boolean) => {
    setCheckingUpstream(true);
    try {
      const response = await fetch(`/api/upstream${force ? "?force=1" : ""}`);
      if (response.ok)
        setUpstream((await response.json()) as UpstreamVersionStatus);
    } catch {
      // offline: keep last known
    } finally {
      setCheckingUpstream(false);
    }
  }, []);

  useEffect(() => {
    void loadUpstream(false);
  }, [loadUpstream]);

  useEffect(() => {
    fetch("/api/desktop-settings")
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          data: {
            onDemandDomains?: string[] | null;
            onDemandEffective?: { domains: string[]; source: OnDemandSource };
          } | null,
        ) => {
          if (!data?.onDemandEffective) return;
          setOnDemand({
            domains: data.onDemandEffective.domains,
            source: data.onDemandEffective.source,
            saved: data.onDemandDomains ?? [],
          });
        },
      )
      .catch(() => {});
  }, []);

  const saveOnDemand = useCallback(async (next: string[]) => {
    const normalized = normalizeOnDemandSelection(next);
    setOnDemand((prev) =>
      prev ? { ...prev, saved: normalized, domains: normalized } : prev,
    );
    try {
      const response = await fetch("/api/desktop-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ onDemandDomains: normalized }),
      });
      if (response.ok) {
        const data = (await response.json()) as {
          onDemandDomains?: string[] | null;
          onDemandEffective?: { domains: string[]; source: OnDemandSource };
        };
        if (data.onDemandEffective) {
          setOnDemand({
            domains: data.onDemandEffective.domains,
            source: data.onDemandEffective.source,
            saved: data.onDemandDomains ?? [],
          });
        }
      }
    } catch {
      /* 乐观更新；下次打开重新读 */
    }
  }, []);

  // 缓存保活的真实状态来自 Host 的 agent.state（不是设置页猜的默认值）。
  useEffect(() => {
    if (!sessionId) {
      setCacheWarming(null);
      return;
    }
    let alive = true;
    fetch(`/api/agent/${encodeURIComponent(sessionId)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          data: { state?: { cacheWarming?: CacheWarmingStatusView } } | null,
        ) => {
          if (alive) setCacheWarming(data?.state?.cacheWarming ?? null);
        },
      )
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const update = useCallback(async (patch: Partial<SettingsSnapshot>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (response.ok) setSettings((await response.json()) as SettingsSnapshot);
    } catch {
      // keep optimistic state; next open re-reads
    } finally {
      setSaving(false);
    }
  }, []);

  function changeScale(value: number) {
    setScale(value);
    applyUiScale(value);
    try {
      window.localStorage.setItem(UI_SCALE_STORAGE_KEY, String(value));
    } catch {
      // private mode / restricted storage
    }
  }

  function changeTheme(value: ThemePreference) {
    setTheme(value);
    saveThemePreference(value);
    applyTheme(value);
  }

  async function reloadResources() {
    setReloading(true);
    setNotice(null);
    try {
      const jobs: Promise<unknown>[] = [];
      if (sessionId) {
        jobs.push(
          fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "reload_resources" }),
          }).then((response) => {
            if (!response.ok) throw new Error(`agent ${response.status}`);
          }),
        );
      }
      if (cwd) {
        jobs.push(
          fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`).then(
            (response) => {
              if (!response.ok) throw new Error(`skills ${response.status}`);
            },
          ),
        );
        jobs.push(
          fetch(`/api/extensions?cwd=${encodeURIComponent(cwd)}`).then(
            (response) => {
              if (!response.ok)
                throw new Error(`extensions ${response.status}`);
            },
          ),
        );
      }
      await Promise.all(jobs);
      setNotice("已重新加载扩展与技能");
    } catch (error) {
      setNotice(
        `重新加载失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setReloading(false);
    }
  }

  return (
    <ModalSurface
      panelClassName="t-modal is-open ui-dialog-surface flex max-h-[82vh] w-full max-w-xl flex-col overflow-hidden rounded-[14px]"
      ariaLabelledBy="general-settings-title"
    >
      <div className="flex items-center justify-between border-b border-divider px-4 py-3">
        <h3
          id="general-settings-title"
          className="flex items-center gap-1.5 text-[14px] font-semibold text-ink"
        >
          <Settings2
            size={14}
            strokeWidth={1.8}
            className="text-accent"
            aria-hidden="true"
          />
          常规
        </h3>
        <div className="flex items-center gap-2">
          {saving && (
            <span className="text-[11px] text-ink-faint">保存中…</span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[12px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
          >
            关闭
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
        <section className="flex flex-col gap-2">
          <SectionTitle>语言</SectionTitle>
          <Segmented
            value={preference}
            options={LOCALE_OPTIONS}
            onChange={setPreference}
          />
        </section>

        <section className="flex flex-col gap-2">
          <SectionTitle>界面字号</SectionTitle>
          <Segmented
            value={String(scale)}
            options={UI_SCALE_OPTIONS.map((option) => ({
              label: option.label,
              value: String(option.value),
            }))}
            onChange={(value) => changeScale(Number(value))}
          />
          <p className="text-[11px] text-ink-faint">即时生效，重启后保持。</p>
        </section>

        <section className="flex flex-col gap-1">
          <SectionTitle>思考与交互</SectionTitle>
          <Row label="默认思考等级" hint="新会话的默认推理强度">
            <Segmented
              value={settings?.defaultThinkingLevel ?? "medium"}
              options={THINKING_OPTIONS}
              disabled={!settings}
              onChange={(value) => void update({ defaultThinkingLevel: value })}
            />
          </Row>
          <Row label="运行中按 Enter" hint="运行中发消息：打断当前回复还是排队">
            <Segmented
              value={settings?.steeringMode ?? "one-at-a-time"}
              options={ENTER_OPTIONS}
              disabled={!settings}
              onChange={(value) => void update({ steeringMode: value })}
            />
          </Row>
        </section>

        <section className="flex flex-col gap-1">
          <SectionTitle>显示</SectionTitle>
          <Row
            label="夜晚模式"
            hint="跟随系统，或强制浅色 / 深色（即时生效，重启后保持）"
          >
            <Segmented
              value={theme}
              options={THEME_OPTIONS}
              onChange={changeTheme}
            />
          </Row>
          <Row label="隐藏思考过程" hint="折叠块不再展示模型推理内容">
            <Toggle
              checked={settings?.hideThinkingBlock ?? false}
              onChange={(next) => void update({ hideThinkingBlock: next })}
            />
          </Row>
          <Row label="显示缓存未命中提示" hint="上下文缓存失效时给出提示">
            <Toggle
              checked={settings?.showCacheMissNotices ?? false}
              onChange={(next) => void update({ showCacheMissNotices: next })}
            />
          </Row>
          <Row label="显示图片" hint="工具结果中的图片是否展开显示">
            <Toggle
              checked={settings?.showImages ?? true}
              onChange={(next) => void update({ showImages: next })}
            />
          </Row>
        </section>

        <section className="flex flex-col gap-1">
          <SectionTitle>运行</SectionTitle>
          <Row label="自动压缩上下文" hint="接近窗口上限时自动总结旧轮次">
            <Toggle
              checked={settings?.compactionEnabled ?? true}
              onChange={(next) => void update({ compactionEnabled: next })}
            />
          </Row>
          <Row label="自动重试" hint="请求失败时按退避策略重试">
            <Toggle
              checked={settings?.retryEnabled ?? true}
              onChange={(next) => void update({ retryEnabled: next })}
            />
          </Row>
          <Row
            label="缓存保活"
            hint={
              cacheWarming
                ? `生效值 ${cacheWarming.mode} · 当前 ${cacheWarming.state}${
                    cacheWarming.reason ? `（${cacheWarming.reason}）` : ""
                  }${cacheWarming.prewarm ? ` · 预热${cacheWarming.prewarm.sent ? "已发" : "跳过"}` : ""}`
                : "按模型声明的 TTL 重放前缀（maxTokens=1）；换取下一轮更快、更便宜"
            }
          >
            <Segmented
              value={settings?.cacheWarming ?? "idle"}
              options={CACHE_WARMING_OPTIONS}
              disabled={!settings}
              onChange={(value) => void update({ cacheWarming: value })}
            />
          </Row>
          <Row
            label="按需工具域"
            hint={
              onDemand
                ? `${formatOnDemandSummary(onDemand)}${
                    isSettingsOverriddenByEnv(onDemand.source)
                      ? "（环境变量生效，设置项暂不生效）"
                      : "（改动对新建会话生效，当前会话需重新加载）"
                  }`
                : "勾选的域默认不声明，首次使用时用 tool_search 激活"
            }
          >
            <div className="flex flex-wrap gap-1.5">
              {ON_DEMAND_DOMAIN_OPTIONS.map((option) => {
                const checked = (onDemand?.saved ?? []).includes(option.value);
                const disabled = isSettingsOverriddenByEnv(
                  onDemand?.source ?? "default",
                );
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={checked}
                    aria-label={option.label}
                    disabled={disabled}
                    onClick={() =>
                      void saveOnDemand(
                        checked
                          ? (onDemand?.saved ?? []).filter(
                              (name) => name !== option.value,
                            )
                          : [...(onDemand?.saved ?? []), option.value],
                      )
                    }
                    className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                      checked
                        ? "border-[#BFD3F7] bg-[#E8EFFB] text-[#2563EB]"
                        : "border-[#E3E3E7] bg-white text-ink-muted"
                    } ${disabled ? "opacity-50" : "hover:border-[#C9D9F2]"}`}
                  >
                    {option.value}
                  </button>
                );
              })}
            </div>
          </Row>
          {onDemand && onDemandWarning(onDemand.saved) && (
            <p className="px-1 text-[11px] leading-4 text-[#B45309]">
              {onDemandWarning(onDemand.saved)}
            </p>
          )}
          {onDemand &&
            !isSettingsOverriddenByEnv(onDemand.source) &&
            onDemand.saved.length === 0 && (
              <p className="px-1 text-[11px] leading-4 text-ink-muted">
                没有勾选 = 全部常驻（等价于 PIFORGE_ON_DEMAND_DOMAINS=0）。
              </p>
            )}
          <Row label="技能命令" hint="把已安装技能注册成斜杠命令">
            <Toggle
              checked={settings?.enableSkillCommands ?? false}
              onChange={(next) => void update({ enableSkillCommands: next })}
            />
          </Row>
        </section>

        <section className="flex flex-col gap-1">
          <SectionTitle>pi 核心版本</SectionTitle>
          <Row
            label={upstream ? `当前 ${upstream.local}` : "当前版本读取中…"}
            hint={
              upstream?.hasUpdate && upstream.latest
                ? `上游已发布 ${upstream.latest}；选版本 → 安装 → 重启生效`
                : upstream?.latest
                  ? `上游最新 ${upstream.latest}（已同步）· 也可以回退到任意旧版本`
                  : "无法连接 npm registry，仅显示本地版本"
            }
          >
            <span className="text-[11px] text-ink-faint">
              {checkingUpstream
                ? "检查中…"
                : upstream?.hasUpdate
                  ? "有更新"
                  : ""}
            </span>
          </Row>
          <PiCoreVersionPicker
            local={upstream?.local ?? null}
            latest={upstream?.latest ?? null}
            checking={checkingUpstream}
            onRecheck={() => void loadUpstream(true)}
          />
        </section>

        <section className="flex flex-col gap-2">
          <SectionTitle>热加载</SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void reloadResources();
              }}
              disabled={reloading}
              className="rounded-lg border border-divider px-2.5 py-1.5 text-[12px] text-ink-muted transition-colors hover:bg-[#F5F5F7] hover:text-ink disabled:opacity-60"
            >
              {reloading ? "重新加载中…" : "重新加载扩展与技能"}
            </button>
            {notice && (
              <span className="text-[11px] text-ink-faint">{notice}</span>
            )}
          </div>
          <p className="text-[11px] text-ink-faint">
            修改扩展 / SKILL.md 后无需重启：下次发送消息或点此按钮立即生效。
          </p>
        </section>
      </div>
    </ModalSurface>
  );
}
