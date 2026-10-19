"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMessage, SessionInfo, SessionTreeNode } from "@/lib/types";
import { useAgentSession } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { BranchCloneModal, type BranchCloneMode } from "./BranchCloneModal";
import { BranchNavigator } from "./BranchNavigator";
import { Composer } from "./Composer";
import { ExtensionUiDialog } from "./ExtensionUiDialog";
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
  });

  const currentModel = chat.displayModel ?? null;
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
    />
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
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      sessionStats={chat.sessionStats}
      contextUsage={chat.contextUsage}
      currentProvider={currentModel?.provider ?? null}
    />
  );

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[#FCFCFA]">
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
                />
              )}

              {chat.agentRunning && !streaming && (
                <p className="text-[12px] text-ink-faint">PiForge 正在思考…</p>
              )}
            </div>
          </div>
          <div className="shrink-0 px-8 pb-6">
            <div className="mx-auto w-full max-w-3xl">
              {trustCard}
              {composer}
              {statusBar}
            </div>
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center px-8">
          <div className="flex w-full max-w-3xl flex-col items-center">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">PiForge</h1>
            <div className="mt-6 w-full">
              {trustCard}
              {composer}
              {statusBar}
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
    </main>
  );
}

export default ChatSurface;
