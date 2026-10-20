import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findFileReferences,
  parseFileReference,
  resolveFileReferencePath,
  resolveHrefFileReference,
} from "./file-links.ts";

test("parses @ paths and line/column suffixes", () => {
  assert.deepEqual(parseFileReference("@src/index.ts"), { path: "src/index.ts" });
  assert.deepEqual(parseFileReference("components/Workbench.tsx:42"), {
    path: "components/Workbench.tsx",
    line: 42,
  });
  assert.deepEqual(parseFileReference("lib/file-links.ts:12:7"), {
    path: "lib/file-links.ts",
    line: 12,
    column: 7,
  });
});

test("rejects URLs, prose words and parent escapes", () => {
  assert.equal(parseFileReference("https://example.com/a.ts"), null);
  assert.equal(parseFileReference("../secrets.env"), null);
  assert.equal(parseFileReference("just-a-word"), null);
});

test("findFileReferences ignores URL tails and keeps surrounding text", () => {
  const segments = findFileReferences("see @src/index.ts:3 and https://x.dev/a.ts ok");
  const files = segments.filter((segment) => segment.type === "file");
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].reference, { path: "src/index.ts", line: 3 });
  assert.match(segments.map((segment) => segment.value).join(""), /https:\/\/x\.dev\/a\.ts/);
});

test("resolves relative and absolute paths", () => {
  assert.equal(
    resolveFileReferencePath({ path: "src/index.ts" }, "D:/Pi/PiForge"),
    "D:/Pi/PiForge/src/index.ts",
  );
  assert.equal(
    resolveFileReferencePath({ path: "D:/Other/file.ts" }, "D:/Pi/PiForge"),
    "D:/Other/file.ts",
  );
});

test("resolves markdown hrefs", () => {
  assert.deepEqual(resolveHrefFileReference("src/index.ts:9", "D:/Pi/PiForge"), {
    path: "D:/Pi/PiForge/src/index.ts",
    line: 9,
    column: undefined,
  });
  assert.equal(resolveHrefFileReference("https://example.com", "D:/Pi"), null);
});
