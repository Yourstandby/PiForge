import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOSE_PREFERENCE_FILENAME,
  isCloseAction,
  parseClosePreference,
  readClosePreference,
  writeClosePreference,
} from "./close-preference.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "piforge-close-pref-"));
}

test("isCloseAction accepts exactly the three actions", () => {
  assert.equal(isCloseAction("ask"), true);
  assert.equal(isCloseAction("minimize"), true);
  assert.equal(isCloseAction("quit"), true);
  assert.equal(isCloseAction("Ask"), false);
  assert.equal(isCloseAction(""), false);
  assert.equal(isCloseAction(null), false);
});

test("parseClosePreference falls back to ask for corruption", () => {
  assert.equal(parseClosePreference(null), "ask");
  assert.equal(parseClosePreference([]), "ask");
  assert.equal(parseClosePreference({}), "ask");
  assert.equal(parseClosePreference({ closeAction: "nope" }), "ask");
  assert.equal(parseClosePreference({ closeAction: "quit" }), "quit");
});

test("missing file means ask (never silently quit)", () => {
  const dir = tempDir();
  try {
    assert.equal(readClosePreference(join(dir, CLOSE_PREFERENCE_FILENAME)), "ask");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write then read round-trips the remembered action", () => {
  const dir = tempDir();
  const file = join(dir, CLOSE_PREFERENCE_FILENAME);
  try {
    assert.equal(writeClosePreference(file, "minimize"), "minimize");
    assert.equal(readClosePreference(file), "minimize");
    assert.equal(writeClosePreference(file, "quit"), "quit");
    assert.equal(readClosePreference(file), "quit");
    assert.equal(writeClosePreference(file, "ask"), "ask");
    assert.equal(readClosePreference(file), "ask");
    // 落盘格式带 version，方便以后迁移
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted json on disk degrades to ask", () => {
  const dir = tempDir();
  const file = join(dir, CLOSE_PREFERENCE_FILENAME);
  try {
    writeFileSync(file, "{ not json");
    assert.equal(readClosePreference(file), "ask");
    writeFileSync(file, JSON.stringify({ closeAction: 42 }));
    assert.equal(readClosePreference(file), "ask");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClosePreference creates missing directories", () => {
  const dir = tempDir();
  const file = join(dir, "nested", "deeper", CLOSE_PREFERENCE_FILENAME);
  try {
    writeClosePreference(file, "quit");
    assert.equal(readClosePreference(file), "quit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
