import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkDevStaticFreshness } from "./dev-static-freshness.mjs";

function fixture({ outAgeSeconds = 0, sourceAgeSeconds = {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "piforge-freshness-"));
  const nowSeconds = Date.now() / 1000;
  mkdirSync(path.join(root, "out"), { recursive: true });
  const outIndex = path.join(root, "out", "index.html");
  writeFileSync(outIndex, "<html></html>");
  utimesSync(outIndex, nowSeconds - outAgeSeconds, nowSeconds - outAgeSeconds);
  for (const [relative, age] of Object.entries(sourceAgeSeconds)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "export {};");
    utimesSync(full, nowSeconds - age, nowSeconds - age);
  }
  return root;
}

test("源码比 out/ 旧时通过", () => {
  const root = fixture({ outAgeSeconds: 10, sourceAgeSeconds: { "components/A.tsx": 600 } });
  const result = checkDevStaticFreshness({ repoRoot: root });
  assert.equal(result.ok, true);
  assert.equal(result.details.staleCount, 0);
});

test("源码比 out/ 新时失败并列出文件", () => {
  const root = fixture({ outAgeSeconds: 600, sourceAgeSeconds: { "components/A.tsx": 10, "lib/b.ts": 20 } });
  const result = checkDevStaticFreshness({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.details.staleCount, 2);
  assert.equal(result.details.staleFiles[0], "components/A.tsx");
  assert.match(result.problems[0], /2 个源码文件比 out\/ 新/);
});

test("忽略单测、文档与 node_modules", () => {
  const root = fixture({
    outAgeSeconds: 600,
    sourceAgeSeconds: {
      "components/A.test.tsx": 1,
      "lib/README.md": 1,
      "node_modules/pkg/index.js": 1,
      "out/_next/x.js": 1,
    },
  });
  assert.equal(checkDevStaticFreshness({ repoRoot: root }).ok, true);
});

test("out/index.html 缺失时直接失败", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "piforge-freshness-empty-"));
  const result = checkDevStaticFreshness({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /out\/index\.html 不存在/);
});

test("容差内的时序抖动不算旧", () => {
  const root = fixture({ outAgeSeconds: 600, sourceAgeSeconds: { "components/A.tsx": 598 } });
  assert.equal(checkDevStaticFreshness({ repoRoot: root, toleranceMs: 5000 }).ok, true);
});
