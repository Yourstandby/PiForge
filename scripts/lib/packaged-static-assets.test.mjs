import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPackagedStaticAssets } from "./packaged-static-assets.mjs";

function makePackage(t, { html, files }) {
  const root = mkdtempSync(join(tmpdir(), "piforge-static-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resourcesDir = join(root, "resources");
  const staticDir = join(resourcesDir, "static");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), html);
  for (const relative of files) {
    const target = join(staticDir, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "x");
  }
  return resourcesDir;
}

test("missing index.html fails loudly", (t) => {
  const root = mkdtempSync(join(tmpdir(), "piforge-static-assets-none-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = checkPackagedStaticAssets(join(root, "resources"));
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /缺少静态直出 index\.html/);
});

test("query strings on static URLs are not treated as separate files", (t) => {
  const resourcesDir = makePackage(t, {
    html: '<link rel="icon" href="/favicon.ico?favicon.2-53ix31norz0.ico"><script src="/_next/static/chunks/a.js"></script>',
    files: ["favicon.ico", "_next/static/chunks/a.js"],
  });
  const result = checkPackagedStaticAssets(resourcesDir);
  assert.deepEqual(result.details.missing, []);
  assert.equal(result.ok, true);
});

test("a dropped chunk is reported as a hydration-breaking gap", (t) => {
  const resourcesDir = makePackage(t, {
    html: '<script src="/_next/static/chunks/a.js"></script><script src="/_next/static/chunks/b.js"></script>',
    files: ["_next/static/chunks/a.js"],
  });
  const result = checkPackagedStaticAssets(resourcesDir);
  assert.equal(result.ok, false);
  assert.deepEqual(result.details.missing, ["/_next/static/chunks/b.js"]);
  assert.match(result.problems.join("\n"), /白屏|空壳/);
});
