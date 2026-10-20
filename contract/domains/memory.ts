/** Long-term-memory DTOs used by the `/api/memory/*` proxy routes. */

export type MemoryType =
  | "pattern"
  | "preference"
  | "architecture"
  | "bug"
  | "workflow"
  | "fact";

export interface RecallHit {
  kind: "memory" | "observation";
  id: string;
  title: string;
  snippet: string;
  score?: number;
  type?: MemoryType | "agent_end" | "pre_compact";
  createdAt: string;
}

export interface MemoryHealth {
  ok: boolean;
  backend: string;
  detail?: string;
  enabled: boolean;
}

export interface MemoryStats {
  memoryCount: number;
  observationCount: number;
}
