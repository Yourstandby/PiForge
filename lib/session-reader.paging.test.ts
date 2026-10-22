import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function sessionFile(dir: string, id: string, name: string | null, mtimeSec: number, userMessages: number) {
  const header = { type: "session", version: 1, id, timestamp: new Date(mtimeSec * 1000).toISOString(), cwd: "D:\\Proj" };
  const lines = [JSON.stringify(header)];
  for (let i = 0; i < userMessages; i++) {
    lines.push(JSON.stringify({ type: "message", id: `${id}-m${i}`, message: { role: "user", content: [{ type: "text", text: `hello ${i}` }] } }));
  }
  if (name) lines.push(JSON.stringify({ type: "session_info", id: `${id}-n`, name }));
  const path = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

test("listSessionsPage only reads the requested window and pages by recency", async () => {
  const previous = process.env[AGENT_DIR_ENV];
  const root = mkdtempSync(join(tmpdir(), "piforge-sessions-page-"));
  const projectDir = join(root, "sessions", "--D--Proj--");
  mkdirSync(projectDir, { recursive: true });
  process.env[AGENT_DIR_ENV] = root;

  try {
    const { invalidateSessionIndex, listSessionsPage, SESSION_PAGE_SIZE } = await import("./session-reader.ts");
    // 45 个会话，只有最近 20 个需要读内容；其余只 stat。
    for (let i = 0; i < 45; i++) {
      sessionFile(projectDir, `id${String(i).padStart(3, "0")}`, i % 3 === 0 ? `会话 ${i}` : null, 1_800_000_000 - i, i % 4);
    }
    invalidateSessionIndex();

    const first = await listSessionsPage({ limit: SESSION_PAGE_SIZE, offset: 0 });
    assert.equal(first.sessions.length, 20, "第一页固定 20 条");
    assert.equal(first.total, 45);
    assert.equal(first.hasMore, true);
    assert.equal(first.sessions[0].id, "id000", "最近修改的排最前");
    assert.equal(first.sessions[19].id, "id019");
    assert.equal(first.sessions[0].name, "会话 0");
    assert.equal(first.sessions[0].messageCount, 0);
    assert.equal(first.sessions[0].firstMessage, "(no messages)");
    assert.equal(first.sessions[3].messageCount, 3, "对话次数 = 用户消息条数");
    assert.equal(first.sessions[3].firstMessage, "hello 0");

    const second = await listSessionsPage({ limit: 10, offset: 20 });
    assert.deepEqual(second.sessions.map((session) => session.id), Array.from({ length: 10 }, (_, i) => `id${String(20 + i).padStart(3, "0")}`));
    assert.equal(second.hasMore, true);

    const last = await listSessionsPage({ limit: 10, offset: 40 });
    assert.equal(last.sessions.length, 5);
    assert.equal(last.hasMore, false);

    // 深链：窗口之外的会话补进本页，方便直接打开
    const kept = await listSessionsPage({ limit: 5, offset: 0, keep: "id040" });
    assert.equal(kept.sessions.length, 6);
    assert.ok(kept.sessions.some((session) => session.id === "id040"));
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
