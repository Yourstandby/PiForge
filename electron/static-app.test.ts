import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStaticAppHandler, mimeTypeFor, resolveStaticFile } from "./static-app.ts";

/**
 * 与 `electron/csp.ts` 的 `buildStaticAppCspHeader()` 保持一致的测试替身：
 * 值导入 `.ts` 在 CommonJS 构建里不可用，所以断言用内联常量（`lib/csp.test.ts`
 * 负责守住真正的 builder）。
 */
const CSP = "default-src 'self'; connect-src 'self' piforge:; script-src 'self'";

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "piforge-static-"));
  writeFileSync(path.join(root, "index.html"), "<!doctype html><title>PiForge</title>");
  mkdirSync(path.join(root, "_next", "static", "chunks"), { recursive: true });
  writeFileSync(path.join(root, "_next", "static", "chunks", "app.js"), "console.log(1)");
  return root;
}

test("mimeTypeFor 覆盖静态直出会遇到的类型", () => {
  assert.equal(mimeTypeFor("a/index.html"), "text/html; charset=utf-8");
  assert.equal(mimeTypeFor("a/app.js"), "text/javascript; charset=utf-8");
  assert.equal(mimeTypeFor("a/app.css"), "text/css; charset=utf-8");
  assert.equal(mimeTypeFor("a/font.woff2"), "font/woff2");
  assert.equal(mimeTypeFor("a/unknown.bin"), "application/octet-stream");
});

test("resolveStaticFile 解析文件、目录索引，并挡住目录穿越", () => {
  const root = makeRoot();
  assert.ok(resolveStaticFile(root, "/index.html")?.endsWith("index.html"));
  assert.ok(resolveStaticFile(root, "/_next/static/chunks/app.js")?.endsWith("app.js"));
  assert.ok(resolveStaticFile(root, "/")?.endsWith("index.html"), "根路径回目录索引");
  assert.equal(resolveStaticFile(root, "/missing.js"), null);
  assert.equal(resolveStaticFile(root, "/../../package.json"), null, "目录穿越必须被拒绝");
  assert.equal(resolveStaticFile(root, "/%2e%2e/%2e%2e/package.json"), null, "编码后的穿越同样拒绝");
});

test("静态处理器：未知路径回退 index.html（单页应用），带扩展名则 404", async () => {
  const root = makeRoot();
  const handler = createStaticAppHandler({ root, getBridge: () => null, log: () => {}, csp: CSP });

  const page = await handler(new Request("piforge://app/?cwd=D%3A%5Cwork"));
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await page.text(), /PiForge/);
  assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self' piforge:/);
  assert.doesNotMatch(page.headers.get("content-security-policy") ?? "", /127\.0\.0\.1/);

  const asset = await handler(new Request("piforge://app/_next/static/chunks/app.js"));
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);

  const missing = await handler(new Request("piforge://app/missing.js"));
  assert.equal(missing.status, 404);
});

test("静态处理器：没有桥时 /api/** 明确 503（而不是静默挂住）", async () => {
  const root = makeRoot();
  const handler = createStaticAppHandler({ root, getBridge: () => null, log: () => {}, csp: CSP });
  const response = await handler(new Request("piforge://app/api/health"));
  assert.equal(response.status, 503);
  const body = (await response.json()) as { error?: string; retryable?: boolean };
  assert.equal(body.retryable, true);
});

test("打包产物缺少 out/ 时报 500 并说明原因（不假装成功）", async () => {
  const handler = createStaticAppHandler({ root: null, getBridge: () => null, log: () => {}, csp: CSP });
  const response = await handler(new Request("piforge://app/"));
  assert.equal(response.status, 500);
  assert.match(await response.text(), /missing/i);
});
