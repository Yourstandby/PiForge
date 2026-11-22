import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findFileReferences,
  parseFileReference,
  parseLinkableFileReference,
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

test("clickability is decided by one rule for prose and inline code", () => {
  // Bare file names are ambiguous -> never clickable...
  assert.equal(parseLinkableFileReference("seed.ts"), null);
  assert.equal(parseLinkableFileReference("package.json"), null);
  // ...unless they carry a separator or an explicit @ prefix.
  assert.deepEqual(parseLinkableFileReference("legacy/seed.ts:3"), {
    path: "legacy/seed.ts",
    line: 3,
  });
  assert.deepEqual(parseLinkableFileReference("@seed.ts"), { path: "seed.ts" });
  // Host/port and bare numbers must never be mistaken for paths.
  assert.equal(parseLinkableFileReference("127.0.0.1:5275"), null);
  assert.equal(parseLinkableFileReference("localhost:3000"), null);
  assert.equal(parseLinkableFileReference("41076"), null);
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
