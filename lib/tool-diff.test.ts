import test from "node:test";
import assert from "node:assert/strict";
import { diffStats } from "./diff-lines.ts";
import { isEditToolName, toolDiffPath, toolDiffRows } from "./tool-diff.ts";

test("edit calls diff oldText against newText", () => {
  const rows = toolDiffRows("edit", {
    path: "src/a.ts",
    oldText: "const a = 1;\nconst b = 2;",
    newText: "const a = 1;\nconst b = 3;",
  });
  assert.ok(rows);
  assert.deepEqual(diffStats(rows), { added: 1, removed: 1 });
  assert.deepEqual(toolDiffPath("edit", { path: "src/a.ts" }), "src/a.ts");
});

test("write calls render the whole file as additions", () => {
  const rows = toolDiffRows("write", { path: "new.md", content: "# title\nbody\n" });
  assert.ok(rows);
  assert.deepEqual(diffStats(rows), { added: 2, removed: 0 });
});

test("camelCase / snake_case field variants are accepted (MCP tools)", () => {
  assert.ok(toolDiffRows("str_replace", { old_string: "a\nb", new_string: "a\nc" }));
  assert.equal(toolDiffPath("write_file", { file_path: "x.txt" }), "x.txt");
  assert.ok(isEditToolName("apply_patch"));
  assert.equal(isEditToolName("read"), false);
});

test("tool calls without usable text produce no diff", () => {
  assert.equal(toolDiffRows("edit", { path: "a.ts" }), null);
  assert.equal(toolDiffRows("read", { path: "a.ts" }), null);
  assert.equal(toolDiffRows("edit", undefined), null);
  assert.equal(toolDiffPath("read", { path: "a.ts" }), null);
});

test("pi's real edit shape (edits[]) renders every replacement", () => {
  const rows = toolDiffRows("edit", {
    path: "components/a.tsx",
    edits: [
      { oldText: "const a = 1;", newText: "const a = 2;" },
      { oldText: "return a;", newText: "return a + 1;" },
    ],
  });
  assert.ok(rows);
  assert.deepEqual(diffStats(rows), { added: 2, removed: 2 });
  const separators = rows.filter((row) => row.kind === "hunk");
  assert.deepEqual(separators.map((row) => row.text), ["@@ 第 1 处修改 @@", "@@ 第 2 处修改 @@"]);
});

test("a single edits[] entry has no separators", () => {
  const rows = toolDiffRows("edit", {
    path: "a.ts",
    edits: [{ oldText: "x", newText: "y" }],
  });
  assert.ok(rows);
  assert.equal(rows.some((row) => row.kind === "hunk"), false);
});

test("malformed edits[] entries are skipped", () => {
  const rows = toolDiffRows("edit", {
    path: "a.ts",
    edits: [{ newText: "only new" }, { oldText: "a", newText: "b" }],
  });
  assert.ok(rows);
  assert.deepEqual(diffStats(rows), { added: 1, removed: 1 });
});
