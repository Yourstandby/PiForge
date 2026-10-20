"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { AgentMessage, SessionInfo, SessionTreeNode } from "@/lib/types";
import { useAgentSession } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
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
  useEffect(() => {
    if (!escAgentRunning) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (escExtensionUi || escTrustPrompt) return;
      event.preventDefault();
      void handleEscAbort();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [escAgentRunning, escExtensionUi, escTrustPrompt, handleEscAbort]);

  // --- Manual context compaction -------------------------------------------
  // The summarising itself is pi's own `compact` command (POST → rpc-manager):
  // we only ask for confirmation and report how many tokens came back.
  const [compactConfirmOpen, setCompactConfirmOpen] = useState(false);
  const [compactToast, setCompactToast] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!compactToast) return;
    const timer = setTimeout(() => setCompactToast(null), 4200);
    return () => clearTimeout(timer);
  }, [compactToast]);

  const canCompact = Boolean(session?.id) && !chat.agentRunning && !chat.isCompacting;

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
