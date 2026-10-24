import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  createLedgerState,
  crossSessionNotesEnabled,
  displayPath,
  findForeignTouch,
  foreignTouchNote,
  formatAge,
  isFileMutationTool,
  MAX_LEDGER_TOUCHES,
  overwriteNote,
  recordFileTouch,
  resetSharedLedger,
  sessionLabel,
  sharedLedger,
} from "./cross-session-ledger.ts";

const CWD = path.resolve("/repo");
const NOW = 1_700_000_000_000;

function record(
  state: ReturnType<typeof createLedgerState>,
  overrides: Partial<{ path: string; sessionId: string; sessionName: string | null; toolName: string; at: number }> = {}
) {
  return recordFileTouch(
    state,
    {
      path: "/repo/src/a.ts",
      cwd: CWD,
      sessionId: "sess-a",
      sessionName: "主干",
      toolName: "edit",
      at: NOW,
      ...overrides,
    },
    overrides.at ?? NOW
  );
}

test("only write/edit count as attributable file mutations", () => {
  assert.equal(isFileMutationTool("write"), true);
  assert.equal(isFileMutationTool("edit"), true);
  // bash / powershell 里的重定向无法稳定归因 —— 宁缺毋滥。
  assert.equal(isFileMutationTool("bash"), false);
  assert.equal(isFileMutationTool("powershell"), false);
});

test("a touch is only visible to other sessions in the same cwd", () => {
  const state = createLedgerState();
  record(state);

  const own = findForeignTouch(state, { path: "/repo/src/a.ts", cwd: CWD, sessionId: "sess-a", now: NOW });
  assert.equal(own, null, "自己的改动不提示自己");

  const other = findForeignTouch(state, { path: "/repo/src/a.ts", cwd: CWD, sessionId: "sess-b", now: NOW });
  assert.equal(other?.sessionId, "sess-a");

  const otherCwd = findForeignTouch(state, {
    path: "/repo/src/a.ts",
    cwd: path.resolve("/other"),
    sessionId: "sess-b",
    now: NOW,
  });
  assert.equal(otherCwd, null, "不同项目目录互不干扰");
});

test("relative and absolute paths resolve to the same ledger entry", () => {
  const state = createLedgerState();
  record(state, { path: path.join(CWD, "src", "a.ts") });

  const hit = findForeignTouch(state, {
    path: "src/a.ts",
    cwd: CWD,
    sessionId: "sess-b",
    now: NOW,
  });
  assert.equal(hit?.sessionId, "sess-a");
});

test("stale touches expire after the TTL", () => {
  const state = createLedgerState();
  record(state);

  const fresh = findForeignTouch(state, { path: "/repo/src/a.ts", cwd: CWD, sessionId: "sess-b", now: NOW + 60_000 });
  assert.ok(fresh);

  const stale = findForeignTouch(state, {
    path: "/repo/src/a.ts",
    cwd: CWD,
    sessionId: "sess-b",
    now: NOW + 31 * 60_000,
  });
  assert.equal(stale, null);
});

test("recording the same file twice keeps only the newest touch and caps the ledger", () => {
  const state = createLedgerState();
  record(state, { toolName: "edit", at: NOW - 60_000 });
  record(state, { toolName: "write", at: NOW });
  assert.equal(state.touches.length, 1);
  assert.equal(state.touches[0].toolName, "write");

  for (let i = 0; i < MAX_LEDGER_TOUCHES + 25; i += 1) {
    record(state, { path: `/repo/src/f${i}.ts`, at: NOW + i });
  }
  assert.ok(state.touches.length <= MAX_LEDGER_TOUCHES);
});

test("note text names the session, the age, the tool and the git command", () => {
  const state = createLedgerState();
  const touch = record(state, { sessionName: "重构登录", at: NOW - 4 * 60_000 });

  assert.equal(formatAge(touch.at, NOW), "4 min ago");
  assert.equal(formatAge(NOW - 30_000, NOW), "just now");
  assert.equal(formatAge(NOW - 2 * 60 * 60_000, NOW), "2 h ago");

  assert.equal(sessionLabel(touch), "「重构登录」");
  assert.equal(displayPath(touch), "src/a.ts");

  const read = foreignTouchNote(touch, NOW);
  assert.match(read, /src\/a\.ts/);
  assert.match(read, /4 min ago/);
  assert.match(read, /重构登录/);
  assert.match(read, /edit/);
  assert.match(read, /git diff -- src\/a\.ts/);

  const overwrite = overwriteNote(touch, NOW);
  assert.match(overwrite, /另一个会话|another session/);
  assert.match(overwrite, /git diff -- src\/a\.ts/);
});

test("a session without a title falls back to a short id", () => {
  const state = createLedgerState();
  const touch = record(state, { sessionName: null, sessionId: "abcdef123456" });
  assert.equal(sessionLabel(touch), "#abcdef");
});

test("cross-session notes can be switched off by env", () => {
  assert.equal(crossSessionNotesEnabled({}), true);
  assert.equal(crossSessionNotesEnabled({ PIFORGE_CROSS_SESSION_NOTES: "1" }), true);
  assert.equal(crossSessionNotesEnabled({ PIFORGE_CROSS_SESSION_NOTES: "0" }), false);
});

test("shared ledger is a process-wide singleton that can be reset", () => {
  resetSharedLedger();
  const first = sharedLedger();
  assert.equal(sharedLedger(), first);
  record(first);
  assert.equal(first.touches.length, 1);
  resetSharedLedger();
  assert.equal(sharedLedger().touches.length, 0);
});
