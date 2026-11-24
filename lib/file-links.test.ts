import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findChatLinks,
  findFileReferences,
  parseLinkableUrl,
  parseFileReference,
  parseLinkableFileReference,
  resolveFileReferencePath,
  resolveHrefFileReference,
} from "./file-links.ts";

test("parses @ paths and line/column suffixes", () => {
  assert.deepEqual(parseFileReference("@src/index.ts"), { path: "src/index.ts" });
  assert.deepEqual(parseFileReference("components/Workbench.tsx:42"), {
    path: "components/Workbench.tsx",
    line: 42,
  });
  assert.deepEqual(parseFileReference("lib/file-links.ts:12:7"), {
    path: "lib/file-links.ts",
    line: 12,
    column: 7,
  });
});

test("rejects URLs, prose words and parent escapes", () => {
  assert.equal(parseFileReference("https://example.com/a.ts"), null);
  assert.equal(parseFileReference("../secrets.env"), null);
  assert.equal(parseFileReference("just-a-word"), null);
});

test("findFileReferences ignores URL tails and keeps surrounding text", () => {
  const segments = findFileReferences("see @src/index.ts:3 and https://x.dev/a.ts ok");
  const files = segments.filter((segment) => segment.type === "file");
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].reference, { path: "src/index.ts", line: 3 });
  assert.match(segments.map((segment) => segment.value).join(""), /https:\/\/x\.dev\/a\.ts/);
});

test("clickability is decided by one rule for prose and inline code", () => {
  // Bare file names are ambiguous -> never clickable...
  assert.equal(parseLinkableFileReference("seed.ts"), null);
  assert.equal(parseLinkableFileReference("package.json"), null);
  // ...unless they carry a separator or an explicit @ prefix.
  assert.deepEqual(parseLinkableFileReference("legacy/seed.ts:3"), {
    path: "legacy/seed.ts",
    line: 3,
  });
  assert.deepEqual(parseLinkableFileReference("@seed.ts"), { path: "seed.ts" });
  // Host/port and bare numbers must never be mistaken for paths.
  assert.equal(parseLinkableFileReference("127.0.0.1:5275"), null);
  assert.equal(parseLinkableFileReference("localhost:3000"), null);
  assert.equal(parseLinkableFileReference("41076"), null);
});

test("resolves relative and absolute paths", () => {
  assert.equal(
    resolveFileReferencePath({ path: "src/index.ts" }, "D:/Pi/PiForge"),
    "D:/Pi/PiForge/src/index.ts",
  );
  assert.equal(
    resolveFileReferencePath({ path: "D:/Other/file.ts" }, "D:/Pi/PiForge"),
    "D:/Other/file.ts",
  );
});

test("resolves markdown hrefs", () => {
  assert.deepEqual(resolveHrefFileReference("src/index.ts:9", "D:/Pi/PiForge"), {
    path: "D:/Pi/PiForge/src/index.ts",
    line: 9,
    column: undefined,
  });
  assert.equal(resolveHrefFileReference("https://example.com", "D:/Pi"), null);
});

test("parseLinkableUrl normalizes bare URLs and host:port", () => {
  assert.equal(parseLinkableUrl("http://127.0.0.1:7878"), "http://127.0.0.1:7878");
  assert.equal(parseLinkableUrl("https://example.com/a.ts"), "https://example.com/a.ts");
  assert.equal(parseLinkableUrl("www.example.com"), "https://www.example.com");
  assert.equal(parseLinkableUrl("localhost:5275"), "http://localhost:5275");
  assert.equal(parseLinkableUrl("http://localhost:5275/"), "http://localhost:5275/");
  // Trailing prose punctuation never enters the href.
  assert.equal(parseLinkableUrl("http://localhost:5275/。"), "http://localhost:5275/");
  assert.equal(parseLinkableUrl("(http://localhost:5275)"), null);
  assert.equal(parseLinkableUrl("seed.ts"), null);
  assert.equal(parseLinkableUrl("127.0.0.1:5275"), "http://127.0.0.1:5275");
});

test("findChatLinks links bare URLs in prose", () => {
  const segments = findChatLinks("后端 → http://127.0.0.1:7878 已启动");
  assert.deepEqual(
    segments.map((segment) => [segment.type, segment.value]),
    [
      ["text", "后端 → "],
      ["url", "http://127.0.0.1:7878"],
      ["text", " 已启动"],
    ],
  );
  assert.equal(segments[1].url, "http://127.0.0.1:7878");
});

test("findChatLinks keeps sentence punctuation out of the link", () => {
  const segments = findChatLinks("浏览器打开 http://localhost:5275/ 即可。");
  const url = segments.find((segment) => segment.type === "url");
  assert.equal(url?.value, "http://localhost:5275/");
  assert.equal(segments[segments.length - 1].value, " 即可。");
});

test("findChatLinks prefers a whole URL over the file reference inside it", () => {
  const segments = findChatLinks("见 https://example.com/a/b.ts 的说明");
  assert.equal(segments.filter((segment) => segment.type === "url").length, 1);
  assert.equal(segments.filter((segment) => segment.type === "file").length, 0);
});

test("findChatLinks keeps host:port and file references side by side", () => {
  const segments = findChatLinks("localhost:5275 日志 logs/vite-dev.log");
  assert.deepEqual(
    segments.filter((segment) => segment.type !== "text").map((segment) => [segment.type, segment.value]),
    [
      ["url", "localhost:5275"],
      ["file", "logs/vite-dev.log"],
    ],
  );
});

test("findChatLinks does not linkify a URL glued to a word", () => {
  const segments = findChatLinks("seehttp://example.com");
  assert.deepEqual(segments.map((segment) => segment.type), ["text"]);
});
