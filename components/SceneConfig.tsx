"use client";

/**
 * 场景档案面板：常规 / 私密一键切换。
 *
 * 私密场景不是「建议」而是**门槛**：五个会出网的通道必须全部落在本地/内网 Provider 上，
 * 否则服务端直接 409，这里把逐条原因摊开给用户看。切换成功后设置模型与权限立即落盘，
 * 并通过 modelsVersion 让会话重新拉取模型、把活跃会话也切过去。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck, ShieldAlert, Sparkles } from "lucide-react";
import { ModalSurface } from "./ModalSurface";
import { ErrorNotice } from "./ErrorNotice";
import {
  SCENE_LANE_LABELS,
  SCENE_MODEL_LANES,
  type SceneLaneIssue,
  type SceneModelLane,
  type SceneName,
  type SceneProfile,
} from "@/lib/scene-profiles";

interface SceneModelOption {
  provider: string;
  id: string;
  name: string;
}

interface SceneProviderInfo {
  id: string;
  baseUrl: string;
  local: boolean;
}

interface SceneAuditResponse {
  ok: boolean;
  issues: SceneLaneIssue[];
  localProviders: string[];
}

interface SceneResponse {
  activeScene: SceneName;
  sceneProfiles: { normal?: SceneProfile; private?: SceneProfile };
  providers: SceneProviderInfo[];
  models: SceneModelOption[];
  audits: { normal: SceneAuditResponse; private: SceneAuditResponse };
  draft: { provider: string; modelId: string; profile: SceneProfile } | null;
}

const laneLabel = (lane: SceneModelLane) => SCENE_LANE_LABELS[lane] ?? lane;

function refKey(ref?: { provider: string; modelId: string }): string {
  return ref ? `${ref.provider}:${ref.modelId}` : "";
}

function fromKey(key: string): { provider: string; modelId: string } | null {
  const index = key.indexOf(":");
  if (index <= 0) return null;
  const provider = key.slice(0, index);
  const modelId = key.slice(index + 1);
  if (!provider || !modelId) return null;
  return { provider, modelId };
}

function issueText(issue: SceneLaneIssue): string {
  const lane = laneLabel(issue.lane);
  if (issue.reason === "unset") return `${lane}：未指定模型`;
  if (issue.reason === "unknown-provider") {
    return `${lane}：Provider「${issue.provider}」找不到地址，无法确认是本地`;
  }
  return `${lane}：${issue.provider} 走的是云端${issue.baseUrl ? `（${issue.baseUrl}）` : ""}`;
}

export function SceneConfig({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<SceneResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<SceneName | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<SceneLaneIssue[] | null>(null);
  const [lanes, setLanes] = useState<Record<SceneModelLane, string>>({
    model: "",
    autoRoutingFast: "",
    autoRoutingStrong: "",
    imageModel: "",
    decisionModel: "",
  });

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/scene")
      .then((r) => r.json() as Promise<SceneResponse>)
      .then((payload) => {
        setData(payload);
        const priv = payload.sceneProfiles.private;
        const draft = priv ?? payload.draft?.profile ?? {};
        setLanes({
          model: refKey(draft.model),
          autoRoutingFast: refKey(draft.autoRoutingFast),
          autoRoutingStrong: refKey(draft.autoRoutingStrong),
          imageModel: refKey(draft.imageModel),
          decisionModel: refKey(draft.decisionModel),
        });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const localProviders = useMemo(
    () => new Set((data?.providers ?? []).filter((p) => p.local).map((p) => p.id)),
    [data],
  );

  const profileFromLanes = useCallback((): SceneProfile | null => {
    const profile: SceneProfile = {};
    let any = false;
    for (const lane of SCENE_MODEL_LANES) {
      const ref = fromKey(lanes[lane]);
      if (ref) {
        profile[lane] = ref;
        any = true;
      }
    }
    return any ? profile : null;
  }, [lanes]);

  const applyScene = useCallback(
    async (scene: SceneName) => {
      setBusy(scene);
      setError(null);
      setBlocked(null);
      try {
        const res = await fetch("/api/scene", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scene,
            ...(scene === "private" ? { profile: profileFromLanes(), saveProfile: true } : {}),
          }),
        });
        const payload = (await res.json()) as {
          error?: string;
          audit?: SceneAuditResponse;
        };
        if (!res.ok) {
          if (payload.audit) setBlocked(payload.audit.issues);
          throw new Error(payload.error ?? `HTTP ${res.status}`);
        }
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [onClose, profileFromLanes],
  );

  const useDraft = useCallback(() => {
    const draft = data?.draft?.profile;
    if (!draft) return;
    setLanes({
      model: refKey(draft.model),
      autoRoutingFast: refKey(draft.autoRoutingFast),
      autoRoutingStrong: refKey(draft.autoRoutingStrong),
      imageModel: refKey(draft.imageModel),
      decisionModel: refKey(draft.decisionModel),
    });
    setBlocked(null);
  }, [data]);

  const active = data?.activeScene ?? "normal";
  const privateIssues = data?.audits.private.issues ?? [];

  return (
    <ModalSurface
      panelClassName="t-modal is-open ui-dialog-surface flex w-full max-w-xl flex-col overflow-hidden rounded-[14px]"
      ariaLabelledBy="scene-config-title"
    >
      <div className="flex items-center justify-between border-b border-divider px-4 py-3">
        <h3
          id="scene-config-title"
          className="flex items-center gap-1.5 text-[14px] font-semibold text-ink"
        >
          {active === "private" ? (
            <ShieldCheck size={14} strokeWidth={1.8} className="text-[#3E8A63]" aria-hidden="true" />
          ) : (
            <ShieldAlert size={14} strokeWidth={1.8} className="text-ink-muted" aria-hidden="true" />
          )}
          场景：常规 / 私密
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
          私密场景下，所有会外发内容的通道（主对话、Auto 快/强档、生图、决策）强制指向本地或内网
          Provider，网页读取与浏览器交互一并关闭。任一通道仍指向云端时，切换会被拒绝。
        </p>

        {loading ? (
          <p className="flex items-center gap-1.5 text-[12px] text-ink-faint">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" /> 读取场景配置…
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-[#E8EFFB] px-2 py-0.5 text-[11px] font-medium text-[#2563EB]">
                当前：{active === "private" ? "私密" : "常规"}
              </span>
              {localProviders.size === 0 && (
                <span className="text-[11px] text-ink-faint">
                  还没有本地 Provider，先在「Provider」里添加 Ollama / 自建网关
                </span>
              )}
            </div>

            <div className="flex flex-col gap-2">
              {SCENE_MODEL_LANES.map((lane) => (
                <label key={lane} className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-ink">{laneLabel(lane)}</span>
                  <select
                    value={lanes[lane]}
                    onChange={(event) =>
                      setLanes((prev) => ({ ...prev, [lane]: event.target.value }))
                    }
                    className="h-8 rounded-md border border-border bg-white px-2 text-[12px] text-ink outline-none focus:border-accent/50"
                  >
                    <option value="">未指定（私密场景不接受）</option>
                    {(data?.models ?? []).map((model) => (
                      <option
                        key={`${model.provider}:${model.id}`}
                        value={`${model.provider}:${model.id}`}
                      >
                        {localProviders.has(model.provider) ? "本地 · " : "云端 · "}
                        {model.provider} / {model.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={useDraft}
                disabled={!data?.draft}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-50"
              >
                <Sparkles size={12} strokeWidth={1.8} aria-hidden="true" />
                用本地模型自动填满
              </button>
              <span className="text-[11px] text-ink-faint">
                五个通道都填本地模型才能切到私密
              </span>
            </div>

            {privateIssues.length > 0 && (
              <div className="rounded-md border border-[#F0DFC0] bg-[#FDF7EC] px-3 py-2">
                <p className="text-[11.5px] font-medium text-[#8A6A2F]">
                  私密档案尚不可用（{privateIssues.length} 项）
                </p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {privateIssues.slice(0, 6).map((issue, index) => (
                    <li key={`${issue.lane}-${index}`} className="text-[11px] text-[#8A6A2F]">
                      {issueText(issue)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {blocked && blocked.length > 0 && (
              <div className="rounded-md border border-[#F0C9C9] bg-[#FDF1F1] px-3 py-2">
                <p className="text-[11.5px] font-medium text-danger">切换被拒绝，仍然会出网：</p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {blocked.map((issue, index) => (
                    <li key={`${issue.lane}-${index}`} className="text-[11px] text-danger">
                      {issueText(issue)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {error && <ErrorNotice className="block text-[12px] text-danger" message={error} />}
          </>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-divider px-4 py-3">
        <button
          type="button"
          onClick={() => void applyScene("normal")}
          disabled={loading || busy !== null}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink disabled:opacity-50"
        >
          {busy === "normal" && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
          切到常规
        </button>
        <button
          type="button"
          onClick={() => void applyScene("private")}
          disabled={loading || busy !== null}
          className="flex items-center gap-1.5 rounded-md bg-[#256B4A] px-4 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy === "private" && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
          切到私密（仅本地模型）
        </button>
      </div>
    </ModalSurface>
  );
}
