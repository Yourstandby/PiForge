/**
 * Type-only re-export for the UI.
 *
 * The queue itself lives in the Agent Host (`agent-host/follow-up-queue.ts`);
 * hooks only need the snapshot shapes.
 */
export type {
  FollowUpImage,
  FollowUpQueueItem,
  FollowUpQueueSnapshot,
  QueuedFollowUp,
} from "../agent-host/follow-up-queue.ts";
