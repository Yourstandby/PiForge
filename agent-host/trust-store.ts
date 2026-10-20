/**
 * Session-only trust decisions (the "trust this session only" options).
 *
 * Persisted decisions live in pi's ProjectTrustStore (trust.json). This map is
 * the in-memory half and must live in the Agent Host so the trust gate and the
 * session lifecycle share one process.
 */
const sessionOnlyTrust = new Map<string, boolean>();

export function getSessionOnlyTrustMap(): Map<string, boolean> {
  return sessionOnlyTrust;
}

export function resetSessionOnlyTrustForTest(): void {
  sessionOnlyTrust.clear();
}
