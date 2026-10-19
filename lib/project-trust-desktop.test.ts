import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyTrustDecision,
  buildTrustOptions,
  evaluateProjectTrust,
} from "./project-trust-desktop.ts";
import { isTrustOptionId } from "./trust-types.ts";

/**
 * Canonicalize the temp dir: on Windows `os.tmpdir()` returns an 8.3 short
 * path, and pi's trust walk compares ancestor
 * `.agents/skills` dirs by string, so a short path no longer matches the
 * user's real home and the user's own skills dir is misread as a project
 * trust resource.
 */
function makeTempProjectDir(prefix: string): string {
  // `realpathSync.native` is the one that expands Windows 8.3 short names.
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

test("buildTrustOptions includes trust/deny and session variants", () => {
  const opts = buildTrustOptions("D:\\proj");
  const ids = opts.map((o) => o.id);
  assert.ok(ids.includes("trust"));
  assert.ok(ids.includes("deny"));
  assert.ok(ids.includes("trust-session"));
  assert.ok(ids.includes("deny-session"));
});

test("no trust-requiring resources → proceed trusted", () => {
  const dir = makeTempProjectDir("pi-trust-empty-");
  try {
    const r = evaluateProjectTrust(dir, { agentDir: join(dir, "agent") });
    assert.equal(r.action, "proceed");
    if (r.action === "proceed") assert.equal(r.trusted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project with .pi/skills and no decision → prompt", () => {
  const dir = makeTempProjectDir("pi-trust-skills-");
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const project = join(dir, "proj");
  mkdirSync(join(project, ".pi", "skills"), { recursive: true });
  writeFileSync(join(project, ".pi", "skills", "x.md"), "# skill\n");
  try {
    const r = evaluateProjectTrust(project, { agentDir });
    assert.equal(r.action, "prompt");
    if (r.action === "prompt") {
      assert.equal(r.payload.needsTrust, true);
      assert.equal(r.payload.cwd, project);
      assert.ok(r.payload.options.length >= 2);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted trust decision skips prompt", () => {
  const dir = makeTempProjectDir("pi-trust-saved-");
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const project = join(dir, "proj");
  mkdirSync(join(project, ".pi", "skills"), { recursive: true });
  writeFileSync(join(project, ".pi", "skills", "x.md"), "# skill\n");
  try {
    applyTrustDecision(project, "trust", { agentDir });
    const r = evaluateProjectTrust(project, { agentDir });
    assert.equal(r.action, "proceed");
    if (r.action === "proceed") assert.equal(r.trusted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session-only trust uses map without disk", () => {
  const dir = makeTempProjectDir("pi-trust-session-");
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const project = join(dir, "proj");
  mkdirSync(join(project, ".pi", "skills"), { recursive: true });
  writeFileSync(join(project, ".pi", "skills", "x.md"), "# skill\n");
  const sessionOnly = new Map<string, boolean>();
  try {
    applyTrustDecision(project, "trust-session", { agentDir, sessionOnlyTrust: sessionOnly });
    assert.equal(sessionOnly.get(project), true);
    const r = evaluateProjectTrust(project, { agentDir, sessionOnlyTrust: sessionOnly });
    assert.equal(r.action, "proceed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isTrustOptionId", () => {
  assert.equal(isTrustOptionId("trust"), true);
  assert.equal(isTrustOptionId("nope"), false);
});
