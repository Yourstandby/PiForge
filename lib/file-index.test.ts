import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyScore, searchFileIndex } from "./file-index.ts";

const entries = [
  { path: "src/app/page.tsx", isDir: false },
  { path: "src/app/layout.tsx", isDir: false },
  { path: "src/components", isDir: true },
  { path: "src/components/Composer.tsx", isDir: false },
  { path: "README.md", isDir: false },
  { path: "docs/guide.md", isDir: false },
];

test("fuzzyScore prefers substring and basename matches", () => {
  assert.ok(fuzzyScore("src/components/Composer.tsx", "composer") > fuzzyScore("src/app/page.tsx", "composer"));
  assert.equal(fuzzyScore("src/app/page.tsx", "zzz"), 0);
});

test("empty query browses shallow entries first", () => {
  const matches = searchFileIndex(entries, "");
  assert.equal(matches[0]?.path, "README.md");
  assert.ok(matches.some((entry) => entry.path === "src/components"));
});

test("query returns ranked matches and honours the limit", () => {
  const matches = searchFileIndex(entries, "comp", 2);
  assert.equal(matches.length, 2);
  assert.match(matches[0]?.path ?? "", /components/);
});

test("directory browse mode lists direct children only", () => {
  const matches = searchFileIndex(entries, "src/");
  assert.ok(matches.every((entry) => !entry.path.slice(4).includes("/") || entry.path === "src/components"));
});
