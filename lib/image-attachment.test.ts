import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  SKIP_DOWNSCALE_BYTES,
  SCHEDULE_HINT,
  estimateImageTokens,
  fitWithin,
  imageExtensionForMime,
  shouldDownscale,
} from "./image-attachment.ts";

test("fitWithin respects both the edge cap and the pixel budget", () => {
  const fitted = fitWithin(2798, 1800);
  assert.ok(Math.max(fitted.width, fitted.height) <= MAX_IMAGE_EDGE);
  assert.ok(fitted.width * fitted.height <= MAX_IMAGE_PIXELS);
  const ratio = 2798 / 1800;
  assert.ok(Math.abs(fitted.width / fitted.height - ratio) < 0.01);
});

test("a 2000x1287 screenshot drops well under the pixel budget (≈1/3 of the tokens)", () => {
  const fitted = fitWithin(2000, 1287);
  assert.ok(fitted.width * fitted.height <= MAX_IMAGE_PIXELS);
  const before = estimateImageTokens(2000, 1287);
  const after = estimateImageTokens(fitted.width, fitted.height);
  assert.ok(after < before * 0.5, `${after} should be < half of ${before}`);
});

test("fitWithin never upscales tiny images", () => {
  assert.deepEqual(fitWithin(320, 200), { width: 320, height: 200 });
});

test("fitWithin leaves already-small images untouched", () => {
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
});

test("shouldDownscale triggers on the long edge or on a big payload", () => {
  assert.equal(shouldDownscale(2798, 1800, 100_000), true);
  assert.equal(shouldDownscale(800, 600, SKIP_DOWNSCALE_BYTES + 1), true);
  assert.equal(shouldDownscale(800, 600, 100_000), false);
});

test("estimateImageTokens follows the pixel/750 heuristic and never goes negative", () => {
  assert.equal(estimateImageTokens(750, 1), 1);
  assert.equal(estimateImageTokens(1568, 882), Math.round((1568 * 882) / 750));
  assert.equal(estimateImageTokens(0, 100), 0);
  assert.equal(estimateImageTokens(Number.NaN, 100), 0);
});

test("imageExtensionForMime maps the common screenshot formats", () => {
  assert.equal(imageExtensionForMime("image/png"), "png");
  assert.equal(imageExtensionForMime("image/jpeg"), "jpg");
  assert.equal(imageExtensionForMime("image/jpg"), "jpg");
  assert.equal(imageExtensionForMime("image/webp"), "webp");
  assert.equal(imageExtensionForMime("application/octet-stream"), "png");
});

test("SCHEDULE_HINT documents why downscaling is free quality-wise", () => {
  assert.ok(SCHEDULE_HINT.includes(String(MAX_IMAGE_EDGE)));
});

// 回归：以前用 round 算目标尺寸，4000×3000 会算出 1239×929 = 1151031 像素，
// 刚好比 1.15MP 预算多一点（真机冒烟里 4K 图就是这样“越缩越超”的）。
test("fitWithin never overshoots the pixel budget", () => {
  for (const [w, h] of [[4000, 3000], [3840, 2160], [5120, 2880], [2000, 1287]]) {
    const fit = fitWithin(w, h);
    assert.ok(fit.width * fit.height <= MAX_IMAGE_PIXELS, `${w}x${h} -> ${fit.width}x${fit.height}`);
    assert.ok(Math.max(fit.width, fit.height) <= MAX_IMAGE_EDGE, `${w}x${h} edge over cap`);
    assert.ok(fit.width * fit.height > MAX_IMAGE_PIXELS * 0.9, `${w}x${h} wasted budget`);
  }
});
