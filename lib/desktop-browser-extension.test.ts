import test from "node:test";
import assert from "node:assert/strict";
import {
  htmlToText,
  isLoopbackHttpUrl,
  normalizeBrowserUrl,
} from "./desktop-browser-extension.ts";

test("normalizeBrowserUrl upgrades loopback shorthand to http", () => {
  assert.equal(normalizeBrowserUrl("localhost:5173"), "http://localhost:5173");
  assert.equal(normalizeBrowserUrl("127.0.0.1:3000/app"), "http://127.0.0.1:3000/app");
  assert.equal(normalizeBrowserUrl("http://localhost:8080"), "http://localhost:8080");
  assert.equal(normalizeBrowserUrl("  https://example.com/x  "), "https://example.com/x");
  assert.equal(normalizeBrowserUrl("example.com"), "https://example.com");
  assert.equal(normalizeBrowserUrl(""), "");
});

test("isLoopbackHttpUrl only accepts loopback http(s)", () => {
  assert.equal(isLoopbackHttpUrl("http://localhost:5173"), true);
  assert.equal(isLoopbackHttpUrl("http://127.0.0.1:3000/x"), true);
  assert.equal(isLoopbackHttpUrl("https://example.com"), false);
  assert.equal(isLoopbackHttpUrl("file:///etc/passwd"), false);
  assert.equal(isLoopbackHttpUrl("not a url"), false);
});

test("htmlToText drops scripts and keeps readable text", () => {
  const text = htmlToText(
    "<html><head><style>body{color:red}</style><script>alert('x')</script></head>" +
      "<body><h1>Hello &amp; welcome</h1><p>First para</p><p>Second para</p></body></html>",
  );
  assert.doesNotMatch(text, /alert|color:red/);
  assert.match(text, /Hello & welcome/);
  assert.match(text, /First para/);
  assert.match(text, /Second para/);
});
