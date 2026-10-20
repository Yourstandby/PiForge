/**
 * Persisted tool-output browsing (v0.5.0 stage 4).
 *
 * Large tool results are written under the session's `tool-outputs/` folder by
 * the Agent Host. The renderer asks the Host for pages; the file path must pass
 * the Host-side whitelist.
 */

export interface ToolOutputPageDto {
  file: string;
  text: string;
  /** 0-based start line. */
  offset: number;
  limit: number;
  totalLines: number;
  hasMore: boolean;
}
