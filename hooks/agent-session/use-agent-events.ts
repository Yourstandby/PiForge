"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AgentEventsManager, type AgentEvent, type ConnectionStatus } from "./agent-events-manager";

export type { AgentEvent, ConnectionStatus };

interface UseAgentEventsOptions {
  agentRunning: boolean;
}

export function useAgentEvents({ agentRunning }: UseAgentEventsOptions) {
  const managerRef = useRef<AgentEventsManager | null>(null);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  if (!managerRef.current) {
    managerRef.current = new AgentEventsManager();
  }

  useEffect(() => {
    managerRef.current?.setAgentRunning(agentRunning);
  }, [agentRunning]);

  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;
    manager.setEventHandler((event) => {
      handleAgentEventRef.current?.(event);
    });
    manager.setStatusChangeHandler((status, attempts) => {
      setConnectionStatus(status);
      setReconnectAttempts(attempts);
    });
    return () => {
      manager.setStatusChangeHandler(null);
      manager.cleanup();
    };
  }, []);

  const connectEvents = useCallback((sid: string) => {
    // expectRunning=true: connect may fire before the [agentRunning] effect
    // reaches the manager (see handleSend ordering); express intent now so an
    // early SSE onerror reconnects instead of leaving the UI stuck on Waiting.
    managerRef.current?.connect(sid, true, true);
  }, []);

  /** 手动重连（断流提示里的「立即重连」）。host 会从最后投递的序号续发。 */
  const reconnectEvents = useCallback(() => {
    managerRef.current?.retryNow();
  }, []);

  /** 读实时时间戳的取值器：不走 state，避免每个 token 都触发一次渲染。 */
  const getLastAgentEventAt = useCallback(() => {
    return managerRef.current?.getLastEventAt() ?? 0;
  }, []);

  return {
    handleAgentEventRef,
    connectEvents,
    reconnectEvents,
    getLastAgentEventAt,
    connectionStatus,
    reconnectAttempts,
  };
}
