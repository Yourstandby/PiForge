import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLEET_ALLOWED_TOOLS,
  FleetStoreError,
  MAX_FLEET_PROFILES,
  deleteFleetProfile,
  fleetStorePath,
  getFleetProfile,
  importFleetProfiles,
  listFleetProfiles,
  sanitizeFleetTools,
  saveFleetProfile,
  setFleetStorePathForTest,
} from "./fleet-store.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-fleet-"));
  const file = join(dir, "fleet", "agents.json");
  setFleetStorePathForTest(file);
  return {
    dir,
    file,
    cleanup: () => {
      setFleetStorePathForTest(null);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("fleet profiles persist to a JSON file and reload", () => {
  const env = setup();
  try {
    const saved = saveFleetProfile(env.dir, {
      name: "安全审计员",
      systemPrompt: "只读审计：找出注入风险并给出修复建议。",
      tools: ["read", "grep"],
    });
    assert.ok(saved.id.startsWith("fleet-"));
    assert.equal(saved.persistent, true);
    assert.deepEqual(saved.tools, ["read", "grep"]);

    // 落盘内容可读，且下次读取原样回来。
    const raw = JSON.parse(readFileSync(env.file, "utf8")) as { profiles: unknown[] };
    assert.equal(raw.profiles.length, 1);
    const reloaded = listFleetProfiles(env.dir);
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].name, "安全审计员");
    assert.equal(reloaded[0].systemPrompt, "只读审计：找出注入风险并给出修复建议。");
    assert.equal(getFleetProfile(env.dir, saved.id)?.name, "安全审计员");
  } finally {
    env.cleanup();
  }
});

test("saving the same name updates instead of duplicating", () => {
  const env = setup();
  try {
    const first = saveFleetProfile(env.dir, {
      name: "researcher",
      systemPrompt: "v1",
      tools: ["read"],
    });
    const updated = saveFleetProfile(env.dir, {
      id: first.id,
      name: "researcher",
      systemPrompt: "v2",
      tools: ["read", "ls"],
    });
    assert.equal(updated.id, first.id);
    assert.equal(updated.createdAt, first.createdAt);
    const all = listFleetProfiles(env.dir);
    assert.equal(all.length, 1);
    assert.equal(all[0].systemPrompt, "v2");
    assert.deepEqual(all[0].tools, ["read", "ls"]);
  } finally {
    env.cleanup();
  }
});

test("only whitelisted tools are honoured, with a safe fallback", () => {
  assert.deepEqual(sanitizeFleetTools(["read", "write", "bash", "grep"]), ["read", "grep"]);
  assert.deepEqual(sanitizeFleetTools([]), [...FLEET_ALLOWED_TOOLS]);
  assert.deepEqual(sanitizeFleetTools("nope"), [...FLEET_ALLOWED_TOOLS]);
  assert.deepEqual(sanitizeFleetTools(["write", "edit"]), [...FLEET_ALLOWED_TOOLS]);
});

test("invalid profiles are rejected with a clear error", () => {
  const env = setup();
  try {
    assert.throws(() => saveFleetProfile(env.dir, { name: "", systemPrompt: "x" }), FleetStoreError);
    assert.throws(() => saveFleetProfile(env.dir, { name: "a", systemPrompt: "" }), FleetStoreError);
    assert.throws(
      () => saveFleetProfile(env.dir, { name: "a".repeat(80), systemPrompt: "x" }),
      FleetStoreError,
    );
  } finally {
    env.cleanup();
  }
});

test("delete removes the profile from disk", () => {
  const env = setup();
  try {
    const saved = saveFleetProfile(env.dir, { name: "temp", systemPrompt: "x" });
    assert.equal(deleteFleetProfile(env.dir, saved.id), true);
    assert.equal(deleteFleetProfile(env.dir, saved.id), false);
    assert.deepEqual(listFleetProfiles(env.dir), []);
  } finally {
    env.cleanup();
  }
});

test("import accepts a single object, an array, or a {profiles} document", () => {
  const env = setup();
  try {
    const one = importFleetProfiles(env.dir, {
      name: "imported-one",
      systemPrompt: "from file",
    });
    assert.equal(one.length, 1);

    const many = importFleetProfiles(env.dir, [
      { name: "imported-two", systemPrompt: "a" },
      { name: "imported-three", systemPrompt: "b" },
    ]);
    assert.equal(many.length, 2);

    const doc = importFleetProfiles(env.dir, {
      profiles: [{ name: "imported-four", systemPrompt: "c" }],
    });
    assert.equal(doc.length, 1);
    assert.equal(listFleetProfiles(env.dir).length, 4);
    assert.throws(() => importFleetProfiles(env.dir, []), FleetStoreError);
  } finally {
    env.cleanup();
  }
});

test("a corrupt file degrades to an empty list instead of throwing", () => {
  const env = setup();
  try {
    mkdirSync(join(env.dir, "fleet"), { recursive: true });
    writeFileSync(env.file, "{ this is not json", "utf8");
    assert.deepEqual(listFleetProfiles(env.dir), []);
    // 之后仍然能正常写入。
    saveFleetProfile(env.dir, { name: "recovered", systemPrompt: "x" });
    assert.equal(listFleetProfiles(env.dir).length, 1);
  } finally {
    env.cleanup();
  }
});

test("the profile limit is enforced", () => {
  const env = setup();
  try {
    for (let index = 0; index < MAX_FLEET_PROFILES; index += 1) {
      saveFleetProfile(env.dir, { name: `agent-${index}`, systemPrompt: "x" });
    }
    assert.throws(
      () => saveFleetProfile(env.dir, { name: "one-too-many", systemPrompt: "x" }),
      FleetStoreError,
    );
  } finally {
    env.cleanup();
  }
});

test("the store path sits under the agent dir", () => {
  assert.equal(
    fleetStorePath("/tmp/agent").replace(/\\/g, "/"),
    "/tmp/agent/fleet/agents.json",
  );
});
