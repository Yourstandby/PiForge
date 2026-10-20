import test from "node:test";
import assert from "node:assert/strict";
import { diffLines, diffStats, parseUnifiedDiff } from "./diff-lines.ts";

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@ export function main() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " return a + b;",
  "@@ -20,2 +21,1 @@",
  "-removed();",
  " keep();",
].join("\n");

test("parseUnifiedDiff tracks old/new line numbers per row", () => {
  const rows = parseUnifiedDiff(DIFF);
  const byKind = rows.map((row) => row.kind);
  assert.equal(byKind.filter((kind) => kind === "meta").length, 4);
  assert.equal(byKind.filter((kind) => kind === "hunk").length, 2);

  const context = rows.find((row) => row.text === "const a = 1;");
  assert.deepEqual(context, { kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" });

  const removed = rows.find((row) => row.text === "const b = 2;");
  assert.deepEqual(removed, { kind: "del", oldLine: 2, newLine: null, text: "const b = 2;" });

  const added = rows.filter((row) => row.kind === "add");
  assert.deepEqual(added.map((row) => row.newLine), [2, 3]);

  const secondHunk = rows.filter((row) => row.kind === "hunk")[1];
  assert.match(secondHunk.text, /^@@ -20,2 \+21,1 @@/);
  const removedLater = rows.find((row) => row.text === "removed();");
  assert.deepEqual(removedLater, { kind: "del", oldLine: 20, newLine: null, text: "removed();" });
  const keptLater = rows.find((row) => row.text === "keep();");
  assert.deepEqual(keptLater, { kind: "context", oldLine: 21, newLine: 21, text: "keep();" });
});

test("diffStats counts additions and deletions", () => {
  assert.deepEqual(diffStats(parseUnifiedDiff(DIFF)), { added: 2, removed: 2 });
});

test("header-like content inside a hunk stays content", () => {
  const rows = parseUnifiedDiff(
    ["--- a/x.txt", "+++ b/x.txt", "@@ -1 +1 @@", "--- old dashes", "+++ new pluses"].join("\n"),
  );
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["meta", "meta", "hunk", "del", "add"],
  );
  assert.equal(rows[3].text, "-- old dashes");
  assert.equal(rows[4].text, "++ new pluses");
});

test("untracked /dev/null diff and no-newline marker", () => {
  const rows = parseUnifiedDiff(
    [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "\\ No newline at end of file",
    ].join("\n"),
  );
  const adds = rows.filter((row) => row.kind === "add");
  assert.deepEqual(adds.map((row) => [row.newLine, row.text]), [[1, "hello"], [2, "world"]]);
  assert.equal(rows[rows.length - 1].kind, "meta");
});

test("empty diff yields no rows", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff("   \n"), []);
});

test("diffLines marks replaced lines and keeps shared context", () => {
  const rows = diffLines("a\nb\nc\nd", "a\nb\nB2\nc\nd");
  assert.deepEqual(
    rows.map((row) => `${row.kind}:${row.text}`),
    ["context:a", "context:b", "add:B2", "context:c", "context:d"],
  );
  const added = rows.find((row) => row.kind === "add");
  assert.deepEqual(added, { kind: "add", oldLine: null, newLine: 3, text: "B2" });
});

test("diffLines reports deletions and additions in one hunk", () => {
  const rows = diffLines("keep\nold1\nold2\ntail", "keep\nnew1\ntail");
  assert.deepEqual(
    rows.map((row) => [row.kind, row.text, row.oldLine, row.newLine]),
    [
      ["context", "keep", 1, 1],
      ["del", "old1", 2, null],
      ["del", "old2", 3, null],
      ["add", "new1", null, 2],
      ["context", "tail", 4, 3],
    ],
  );
});

test("diffLines treats an empty old side as a new file", () => {
  const rows = diffLines("", "line1\nline2\n");
  assert.deepEqual(rows.map((row) => [row.kind, row.text, row.newLine]), [
    ["add", "line1", 1],
    ["add", "line2", 2],
  ]);
});

test("diffLines returns nothing for identical text", () => {
  const rows = diffLines("same\ntext", "same\ntext");
  assert.deepEqual(rows.map((row) => row.kind), ["context", "context"]);
  assert.deepEqual(diffStats(rows), { added: 0, removed: 0 });
});
