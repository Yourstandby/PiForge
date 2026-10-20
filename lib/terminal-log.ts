/**
 * Terminal log types re-exported for the UI.
 *
 * The ring buffer itself moved to the Agent Host (`agent-host/terminal-log.ts`).
 * `components/TerminalPanel.tsx` keeps importing from this path so the UI stays
 * untouched across the migration.
 */
export type {
  TerminalBlock,
  TerminalBlockStatus,
} from "../contract/domains/terminal.ts";
