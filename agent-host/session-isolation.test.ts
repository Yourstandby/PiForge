import test from "node:test";
import assert from "node:assert/strict";
import {
  checkSharedSessionsOverlap,
  isIsolatedChildSession,
  resolveChildSessionDir,
} from "./session-isolation.ts";

const AGENT_DIR = String.raw`C:\Users\me\.pi\agent`;
const SHARED = `${AGENT_DIR}\\sessions`;

test("未设置 PIFORGE_SESSION_DIR → in-memory（不落盘，天然隔离）", () => {
  const decision = resolveChildSessionDir({}, SHARED);
  assert.equal(decision.dir, null);
  assert.equal(decision.source, "default_in_memory");
  assert.match(decision.reason, /in-memory/);
});

test("设了独立目录 → 采用它", () => {
  const dir = String.raw`C:\tmp\piforge-ab-sessions`;
  const decision = resolveChildSessionDir({ PIFORGE_SESSION_DIR: dir }, SHARED);
  assert.equal(decision.dir, dir);
  assert.equal(decision.source, "env");
});

test("指向共享 sessions/ 内部 → 拒绝（防污染审计口径）", () => {
  for (const dir of [SHARED, `${SHARED}\\--D--repo--`, `${SHARED}/sub`]) {
    const decision = resolveChildSessionDir({ PIFORGE_SESSION_DIR: dir }, SHARED);
    assert.equal(decision.dir, null, `${dir} 应被拒绝`);
    assert.match(decision.reason, /共享会话目录/);
  }
});

test("Windows 大小写 / 斜杠方向不影响判定", () => {
  const decision = resolveChildSessionDir(
    { PIFORGE_SESSION_DIR: "c:/USERS/me/.pi/AGENT/sessions/x" },
    SHARED,
  );
  assert.equal(decision.dir, null);
});

test("共享根目录的子串前缀不算重叠（sessions-archive 不是 sessions）", () => {
  assert.equal(checkSharedSessionsOverlap(`${AGENT_DIR}\\sessions-archive`, SHARED), null);
  assert.equal(checkSharedSessionsOverlap(`${SHARED}\\x`, SHARED), "位于共享根目录之内");
  assert.equal(checkSharedSessionsOverlap(SHARED, SHARED), "与共享根目录相同");
});

test("isIsolatedChildSession：null 永远安全；未给共享根时不做判断", () => {
  assert.equal(isIsolatedChildSession(null, SHARED), true);
  assert.equal(isIsolatedChildSession(`${SHARED}\\x`, SHARED), false);
  assert.equal(isIsolatedChildSession(String.raw`C:\tmp\x`, SHARED), true);
  assert.equal(isIsolatedChildSession(`${SHARED}\\x`, undefined), true);
});
