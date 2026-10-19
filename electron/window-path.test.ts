import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWindowPath } from "./window-path.ts";

test("normalizeWindowPath accepts same-origin app paths", () => {
  assert.equal(normalizeWindowPath("/"), "/");
  assert.equal(normalizeWindowPath("/?cwd=D%3A%5CPi%5Cdemo"), "/?cwd=D%3A%5CPi%5Cdemo");
  assert.equal(normalizeWindowPath("/?session=abc"), "/?session=abc");
});

test("normalizeWindowPath rejects external and malformed targets", () => {
  assert.equal(normalizeWindowPath(undefined), "/");
  assert.equal(normalizeWindowPath(null), "/");
  assert.equal(normalizeWindowPath(42), "/");
  assert.equal(normalizeWindowPath("https://example.com"), "/");
  assert.equal(normalizeWindowPath("//evil.example"), "/");
  assert.equal(normalizeWindowPath("file:///C:/Windows"), "/");
  assert.equal(normalizeWindowPath("?cwd=D%3A%5CPi"), "/");
});
