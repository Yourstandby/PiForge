/** Fleet agent profiles: the persistent, manually-managed side of the Agents panel. */

/** Which model lane the fleet agent should use is left to the session (host default). */
export interface FleetAgentProfile {
  id: string;
  name: string;
  /** Replaces the built-in fleet system prompt. */
  systemPrompt: string;
  /** Tool allowlist (only read-only tools are honoured). */
  tools: string[];
  /** 常驻待命：重启后回显，随时可以被唤醒。 */
  persistent: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Panel row: a profile plus its live runtime state (if any). */
export interface FleetAgentRow {
  profile: FleetAgentProfile;
  /** Live herdr agent id, once woken. */
  agentId: string | null;
  status: "idle" | "starting" | "running" | "stopped" | "crashed";
  turns: number;
  lastActiveAt: number | null;
}

export interface FleetSnapshot {
  profiles: FleetAgentProfile[];
  /** Live fleet agents (herdr-manager), also shown in the Agents panel. */
  agents: import("./herdr.ts").HerdrAgentView[];
}
