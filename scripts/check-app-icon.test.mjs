import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readIcoSizes } from "./check-app-icon.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("readIcoSizes lists every square frame of the ICO", () => {
  const sizes = readIcoSizes(readFileSync(path.join(root, "build", "icon.ico")));
  for (const size of [16, 32, 48, 256]) {
    assert.ok(sizes.includes(size), `expected a ${size}x${size} frame, got ${sizes.join("/")}`);
  }
});

test("readIcoSizes rejects non-ICO payloads", () => {
  assert.throws(() => readIcoSizes(Buffer.from("not an icon")), /有效的 .ico/);
});

test("the shipped Windows icon covers the sizes Windows Explorer asks for", () => {
  const sizes = readIcoSizes(readFileSync(path.join(root, "build", "icon.ico")));
  assert.deepEqual([...new Set(sizes)].sort((a, b) => a - b), [16, 24, 32, 48, 64, 128, 256]);
});
