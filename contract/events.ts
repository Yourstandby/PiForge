/**
 * Event topics pushed by the Agent Host.
 *
 * The host multiplexes every subscription over the same pipe connection.
 * Events are ordered per subscription by a monotonically increasing `seq`.
 */
import type { ManagedProcessView } from "./domains/processes.ts";
import type { TerminalBlock } from "./domains/terminal.ts";
import type { SubagentSnapshot } from "./domains/subagents.ts";

/** Topics that a client can subscribe to for the whole host lifetime. */
export type GlobalTopic = "processes" | "terminal" | "subagents";

/** Wire topic emitted for each global subscription topic. */
export const GLOBAL_TOPIC_EVENT = {
  processes: "processes.changed",
  terminal: "terminal.changed",
  subagents: "subagents.changed",
} as const;

export interface HostEventPayloads {
  "host.shuttingDown": {
    reason: string;
    /** Unix epoch ms after which the host process is gone. */
    deadline: number;
  };
  "processes.changed": {
    processes: ManagedProcessView[];
  };
  "terminal.changed": {
    blocks: TerminalBlock[];
  };
  "subagents.changed": SubagentSnapshot;
  "agent.event": {
    sessionId: string;
    event: Record<string, unknown>;
  };
  "agent.lagged": {
    sessionId: string;
    fromSeq: number;
    reason: "slow_subscriber" | "buffer_overflow";
  };
}

export type HostEventTopic = keyof HostEventPayloads;

/**
 * Maps a subscription topic to the payload its listeners receive, so route
 * adapters never have to repeat the topic-to-event mapping.
 */
export type GlobalEventPayloads = {
  [K in GlobalTopic]: HostEventPayloads[(typeof GLOBAL_TOPIC_EVENT)[K]];
};
