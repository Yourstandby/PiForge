"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ListTodo } from "lucide-react";
import type { AgentMessage, SessionInfo, SessionTreeNode } from "@/lib/types";
import { useAgentSession } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useHostHealth } from "@/hooks/useHostHealth";
import { conversationToMarkdown } from "@/lib/conversation-markdown";
import { BranchCloneModal, type BranchCloneMode } from "./BranchCloneModal";
import { BranchNavigator } from "./BranchNavigator";
import { Composer } from "./Composer";
import { ExtensionUiDialog } from "./ExtensionUiDialog";
import { ModalSurface } from "./ModalSurface";
import { StatusBar, type ThinkingLevel } from "./StatusBar";
import { Transcript } from "./Transcript";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  draft: string;
  modelsRefreshKey?: number;
  onDraftChange: (value: string) => void;
  onSessionCreated: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  /** Auto title / rename landed; ask the sidebar to refetch. */
  onSessionRenamed?: () => void;
  /** Open a file reference from the transcript in the file viewer. */
  onOpenFile?: (filePath: string, fileName: string, line?: number) => void;
  /**
   * False while this pane sits in a background session tab. Global shortcuts
   * (Esc = abort) must only fire for the tab the user is looking at.
   */
  active?: boolean;
  /** `/new` slash command: start a fresh session in the current project. */
  onNewSession?: () => void;
  /** Insert a rendered Markdown code block into the composer. */
  onInsertCode?: (code: string, language?: string) => void;
  /** Open the repository Git Diff pane in the right panel. */
  onOpenGitDiff?: () => void;
}

/**
 * Owns the remount key used to reload a canonical transcript from disk.
 *
 * A brand-new session's first prompt is dispatched by POST /api/agent/new
 * *before* the SSE stream can attach, so a fast model can finish the whole
 * turn before we subscribe and agent_end is never observed. Polling the
 * server's running flag closes that gap (and any dropped-event gap) without
 * touching the shared send logic.
 */
export function ChatSurface(props: Props) {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  return <ChatSession key={reloadKey} {...props} onReload={reload} />;
}

function ChatSession({
  session,
  newSessionCwd,
  draft,
  modelsRefreshKey,
  onDraftChange,
  onSessionCreated,
  onSessionForked,
  onSessionRenamed,
  onOpenFile,
  onNewSession,
  onInsertCode,
  onOpenGitDiff,
  active = true,
  onReload,
}: Props & { onReload: () => void }) {
  const { soundEnabled, onSoundToggle, playDoneSound } = useAudio();

  // Branch tree state — the hook owns the data, BranchNavigator renders it.
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchLeafId, setBranchLeafId] = useState<string | null>(null);
  const branchLeafChangeRef = useRef<((leafId: string | null) => void) | null>(null);
  const [branchModal, setBranchModal] = useState<{
    isOpen: boolean;
    mode: BranchCloneMode;
    targetEntryId?: string;
  }>({ isOpen: false, mode: "branch" });

  const handleBranchDataChange = useCallback(
    (
      tree: SessionTreeNode[],
      activeLeafId: string | null,
      onLeafChange: (leafId: string | null) => void,
    ) => {
      setBranchTree(tree);
      setBranchLeafId(activeLeafId);
      branchLeafChangeRef.current = onLeafChange;
    },
    [],
  );

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeRef.current?.(leafId);
  }, []);

  const chat = useAgentSession({
    session,
    newSessionCwd,
    modelsRefreshKey,
    onSessionCreated,
    onSessionForked,
    onBranchDataChange: handleBranchDataChange,
    onAgentEnd: playDoneSound,
    onSessionRenamed: () => onSessionRenamed?.(),
    onNewSession,
  });

  const currentModel = chat.displayModel ?? null;
  const {
    agentRunning: escAgentRunning,
    extensionUiRequest: escExtensionUi,
    trustPrompt: escTrustPrompt,
    handleAbort: handleEscAbort,
  } = chat;

  // Esc = hard interrupt while the agent is generating. Menus/dialogs consume
  // Escape first via preventDefault, so this only fires when nothing else did.
  // Background session tabs stay mounted, so gate on `active` to keep one
  // keystroke from aborting every running tab.
  useEffect(() => {
    if (!escAgentRunning || !active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (escExtensionUi || escTrustPrompt) return;
      event.preventDefault();
      void handleEscAbort();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [escAgentRunning, escExtensionUi, escTrustPrompt, handleEscAbort, active]);

  // --- Manual context compaction -------------------------------------------
  // The summarising itself is pi's own `compact` command (POST → rpc-manager):
  // we only ask for confirmation and report how many tokens came back.
  const [compactConfirmOpen, setCompactConfirmOpen] = useState(false);
  const [compactToast, setCompactToast] = useState<{ ok: boolean; text: string } | null>(null);

  // Engine liveness: reuse the existing transient toast so the UI layout is
  // unchanged, and disable sending while the host is not ready so a message
  // cannot silently disappear during a reconnect.
  const hostHealth = useHostHealth();
  const hostWasDown = useRef(false);
  useEffect(() => {
    const down = hostHealth.state === "reconnecting" || hostHealth.state === "offline";
    if (down && !hostWasDown.current) {
      hostWasDown.current = true;
      setCompactToast({ ok: false, text: hostHealth.message });
    } else if (hostHealth.state === "ready" && hostWasDown.current) {
      hostWasDown.current = false;
      setCompactToast({ ok: true, text: "后台引擎已恢复" });
    }
  }, [hostHealth.state, hostHealth.message]);

  useEffect(() => {
    if (!compactToast) return;
    const timer = setTimeout(() => setCompactToast(null), 4200);
    return () => clearTimeout(timer);
  }, [compactToast]);

  const canCompact = Boolean(session?.id) && !chat.agentRunning && !chat.isCompacting;

  /** Ctrl/Cmd+Shift+C: whole conversation as Markdown on the clipboard. */
  const copyConversation = useCallback(async () => {
    const markdown = conversationToMarkdown(chat.messages);
    try {
      await navigator.clipboard.writeText(markdown);
      setCompactToast({ ok: true, text: "对话已复制" });
    } catch {
      setCompactToast({ ok: false, text: "复制失败：剪贴板不可用" });
    }
  }, [chat.messages]);

  /** Ctrl/Cmd+K: same reset as the /clear slash command. */
  const clearConversation = useCallback(() => {
    if (chat.agentRunning) {
      setCompactToast({ ok: false, text: "正在生成，先按 Esc 中断" });
      return;
    }
    void chat.handleSend("/clear");
    setCompactToast({ ok: true, text: "已清空当前对话视图" });
  }, [chat]);

  // Global (active-tab only) shortcuts. Capture phase so a focused textarea
  // cannot swallow them. Dialogs keep the keyboard to themselves.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      if (event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void copyConversation();
        return;
      }
      if (!event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        clearConversation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, copyConversation, clearConversation]);

  const runCompact = useCallback(async () => {
    setCompactConfirmOpen(false);
    const outcome = await chat.handleCompact();
    if (outcome.ok) {
      const saved =
        outcome.tokensBefore != null && outcome.tokensAfter != null
          ? Math.max(0, outcome.tokensBefore - outcome.tokensAfter)
          : null;
      setCompactToast({
        ok: true,
        text:
          saved && saved > 0
            ? `已压缩历史，释放了 ${saved.toLocaleString("en-US")} Tokens`
            : "已压缩历史",
      });
    } else {
      setCompactToast({ ok: false, text: `压缩失败：${outcome.error}` });
    }
  }, [chat]);
  const availableThinkingLevels = currentModel
    ? (chat.modelThinkingLevels[`${currentModel.provider}:${currentModel.modelId}`] ?? null)
    : null;

  const streaming = chat.streamState.isStreaming ? chat.streamState.streamingMessage : null;
  const messages: AgentMessage[] = streaming
    ? [...chat.messages, streaming as AgentMessage]
    : chat.messages;

  // No session yet + no messages = the hero composer. Once a session is
  // selected (or a first message is queued) switch to the transcript view.
  const showTranscript = messages.length > 0 || session !== null || Boolean(chat.error);

  // Reconcile with the server when the run ends without us seeing agent_end.
  useEffect(() => {
    if (!chat.agentRunning || !session) return;
    let cancelled = false;
    let idleReads = 0;

    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(session.id)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { running?: boolean };
        if (cancelled) return;
        if (data.running) {
          idleReads = 0;
          return;
        }
        idleReads += 1;
        if (idleReads >= 2) {
          clearInterval(timer);
          onReload();
        }
      } catch {
        // Keep the current view; a transient poll failure is not fatal.
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [chat.agentRunning, session, onReload]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, chat.streamState.streamingMessage, chat.agentRunning]);

  const trust = chat.trustPrompt;
  const trustCard = trust ? (
    <div className="mb-3 rounded-xl border border-[#D9E5FB] bg-[#F5F9FF] px-4 py-3">
      <p className="text-[12px] text-ink-muted">
        运行前需要确认信任该项目：
        <span className="ml-1 font-mono text-[11px] text-ink-soft">{trust.cwd}</span>
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {trust.options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => chat.resolveTrustPrompt(option.id)}
            className="rounded-md border border-[#D9E5FB] bg-white px-2.5 py-1 text-[12px] text-ink-soft transition-colors hover:border-accent/40 hover:text-accent-strong"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  ) : null;

  const composer = (
    <div className="flex flex-col gap-2">
      {chat.canExecutePlan && chat.agentMode === "plan" && (
        <div
          role="group"
          aria-label="计划已生成"
          className="flex items-center gap-2 self-start rounded-xl border border-[#D9E5FB] bg-[#F5F9FF] px-2.5 py-1.5 text-[12px] text-ink-soft shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
        >
          <ListTodo size={13} strokeWidth={1.9} className="shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0">计划已生成，批准后开始执行。</span>
          <button
            type="button"
            onClick={() => {
              void chat.handleExecutePlan();
            }}
            disabled={chat.agentRunning}
            className="ml-1 shrink-0 rounded-md bg-accent px-2 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            批准并执行
          </button>
          <button
            type="button"
            onClick={() => chat.dismissPlan()}
            className="shrink-0 rounded-md px-1.5 py-1 text-[11.5px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
          >
            拒绝
          </button>
        </div>
      )}
      {compactToast && (
        <div
          role="status"
          className={`flex items-center gap-1.5 self-start rounded-lg border bg-white px-2.5 py-1.5 text-[12px] shadow-[0_1px_3px_rgba(15,23,42,0.06)] ${
            compactToast.ok
              ? "border-[#D9E5FB] text-ink-soft"
              : "border-[#F5D3D3] text-danger"
          }`}
        >
          {compactToast.ok ? (
            <CheckCircle2 size={13} strokeWidth={2} className="shrink-0 text-accent" aria-hidden="true" />
          ) : (
            <AlertCircle size={13} strokeWidth={2} className="shrink-0" aria-hidden="true" />
          )}
          {compactToast.text}
        </div>
      )}
      <Composer
        value={draft}
        onValueChange={onDraftChange}
        busy={chat.agentRunning}
        disabled={hostHealth.state !== "ready"}
        onStop={() => {
          void chat.handleAbort();
        }}
        onSubmit={(text, images) => {
          void chat.handleSend(text, images);
        }}
        onSteer={(text, images) => {
          void chat.handleSteer(text, images).catch((error) => {
            setCompactToast({
              ok: false,
              text: `打断失败：${error instanceof Error ? error.message : String(error)}`,
            });
          });
        }}
        onFollowUp={(text, images) => {
          void chat.handleFollowUp(text, images).catch((error) => {
            setCompactToast({
              ok: false,
              text: `加入队列失败：${error instanceof Error ? error.message : String(error)}`,
            });
          });
        }}
        queuedFollowUps={chat.followUpQueue.items}
        onReorderFollowUps={chat.handleReorderFollowUps}
        queueBusy={chat.followUpQueueBusy}
        cwd={session?.cwd ?? newSessionCwd ?? null}
      />
    </div>
  );

  const statusBar = (
    <StatusBar
      isStreaming={chat.agentRunning}
      model={currentModel}
      modelNames={chat.modelNames}
      modelList={chat.modelList}
      onModelChange={chat.handleModelChange}
      thinkingLevel={chat.thinkingLevel as ThinkingLevel}
      availableThinkingLevels={availableThinkingLevels}
      onThinkingLevelChange={chat.handleThinkingLevelChange}
      agentMode={chat.agentMode}
      onAgentModeChange={chat.handleAgentModeChange}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onCompactRequest={() => setCompactConfirmOpen(true)}
      onGitDiff={onOpenGitDiff}
      canCompact={canCompact}
      compacting={chat.isCompacting}
      sessionStats={chat.sessionStats}
      contextUsage={chat.contextUsage}
      currentProvider={currentModel?.provider ?? null}
      hostState={hostHealth.state}
      hostTitle={
        hostHealth.state === "ready" && hostHealth.detail
          ? `后台引擎正常 · pid ${hostHealth.detail.pid} · uptime ${Math.round(hostHealth.detail.uptimeMs / 1000)}s`
          : hostHealth.message
      }
    />
  );

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#FCFCFA]">
      {/* Extension UI: an extension awaiting input/select/confirm blocks the
          agent until this dialog answers, so it must render for every view. */}
      <ExtensionUiDialog
        request={chat.extensionUiRequest}
        onRespond={chat.handleExtensionUiRespond}
      />
      {chat.extensionUiNotify && (
        <div
          role="status"
          className="material-popover fixed left-1/2 top-12 z-[900] -translate-x-1/2 rounded-lg px-3 py-2 text-[12px] text-ink shadow-[var(--shadow-popover)]"
        >
          {chat.extensionUiNotify.message}
        </div>
      )}

      {showTranscript && session && (
        <BranchNavigator
          tree={branchTree}
          activeLeafId={branchLeafId}
          onLeafChange={handleBranchLeafChange}
          onBranch={() =>
            setBranchModal({ isOpen: true, mode: "branch", targetEntryId: branchLeafId ?? undefined })
          }
          onClone={() => setBranchModal({ isOpen: true, mode: "clone" })}
          hasSession
        />
      )}

      {showTranscript ? (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-8 py-10">
              {chat.loading && messages.length === 0 ? (
                <p className="py-10 text-center text-[13px] text-ink-faint">加载会话…</p>
              ) : chat.error ? (
                <div className="py-10 text-center">
                  <p className="text-[13px] text-ink-muted">无法加载这段会话</p>
                  <p className="mt-1 text-[11px] text-ink-faint">{chat.error}</p>
                </div>
              ) : (
                <Transcript
                  messages={messages}
                  entryIds={chat.entryIds}
                  onFork={chat.agentRunning ? undefined : chat.handleFork}
                  forkingEntryId={chat.forkingEntryId}
                  cwd={session?.cwd ?? newSessionCwd}
                  onOpenFile={onOpenFile}
                  onInsertCode={onInsertCode}
                  nestedExecutions={chat.nestedToolExecutions}
                />
              )}

              {chat.agentRunning && !streaming && (
                <p className="text-[12px] text-ink-faint">PiForge 正在思考…</p>
              )}
            </div>
          </div>
          <div className="shrink-0 px-8 pb-5">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
              {trustCard}
              {composer}
              <div className="shrink-0">{statusBar}</div>
            </div>
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto bg-[radial-gradient(ellipse_at_center,_#ffffff_0%,_#f8fafd_55%,_#eef3fb_100%)] px-8 py-6">
          <div className="my-auto flex w-full max-w-3xl flex-col items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.svg"
              alt="PiForge"
              width={64}
              height={64}
              draggable={false}
              className="h-16 w-16 select-none"
            />
            <p className="mt-2 text-[13px] text-ink-faint">今天想构建点什么？</p>
            <div className="mt-6 flex w-full flex-col gap-2">
              {trustCard}
              {composer}
              <div className="shrink-0">{statusBar}</div>
            </div>
          </div>
        </div>
      )}

      <BranchCloneModal
        isOpen={branchModal.isOpen}
        onClose={() => setBranchModal((prev) => ({ ...prev, isOpen: false }))}
        mode={branchModal.mode}
        sessionId={session?.id ?? null}
        targetEntryId={branchModal.targetEntryId}
        cwd={session?.cwd ?? newSessionCwd ?? undefined}
        onSuccess={(newSessionId) => onSessionForked?.(newSessionId)}
      />

      {compactConfirmOpen && (
        <ModalSurface
          panelClassName="t-modal is-open ui-dialog-surface flex w-full max-w-sm flex-col overflow-hidden rounded-[14px]"
          ariaLabelledBy="compact-confirm-title"
        >
          <div className="flex flex-col gap-2 px-4 pb-4 pt-3.5">
            <h3 id="compact-confirm-title" className="text-[14px] font-semibold text-ink">
              压缩上下文？
            </h3>
            <p className="text-[12px] leading-relaxed text-ink-muted">
              将调用 Pi 的压缩能力，把较早的对话总结成一段摘要（保留改动过的文件、核心需求、当前进度与下一步），最近的内容完整保留。
            </p>
            <p className="text-[11px] text-ink-faint">
              压缩后原始历史会被摘要替换，无法撤销。
            </p>
          </div>
          <div className="mt-1 flex items-center justify-end gap-2 border-t border-divider px-4 py-3">
            <button
              type="button"
              onClick={() => setCompactConfirmOpen(false)}
              className="rounded-control border border-border px-3 py-1.5 text-[12px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void runCompact()}
              className="rounded-control bg-accent px-4 py-1.5 text-[12px] font-medium text-accent-contrast transition-opacity hover:opacity-90"
            >
              开始压缩
            </button>
          </div>
        </ModalSurface>
      )}
    </main>
  );
}

export default ChatSurface;
