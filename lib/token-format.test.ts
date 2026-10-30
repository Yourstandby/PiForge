import test from "node:test";
import assert from "node:assert/strict";
import { formatTokenCount } from "./token-format.ts";

test("千以内保留精确整数", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(-12), "0");
  assert.equal(formatTokenCount(Number.NaN), "0");
  assert.equal(formatTokenCount(944.4), "944");
  assert.equal(formatTokenCount(999.6), "1.0K");
});

test("千以上用 K，百万以上用 M", () => {
  assert.equal(formatTokenCount(1_000), "1.0K");
  assert.equal(formatTokenCount(2_945), "2.9K");
  assert.equal(formatTokenCount(69_762), "69.8K");
  assert.equal(formatTokenCount(999_949), "999.9K");
  assert.equal(formatTokenCount(999_950), "1.0M");
  assert.equal(formatTokenCount(1_234_567), "1.2M");
});
