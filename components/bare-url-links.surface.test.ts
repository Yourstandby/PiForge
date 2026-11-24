import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const transcript = readFileSync(new URL("./Transcript.tsx", import.meta.url), "utf8");
const links = readFileSync(new URL("../lib/file-links.ts", import.meta.url), "utf8");

/**
 * 模型在正文里写的裸链接（`后端 → http://127.0.0.1:7878`）此前是完全的纯文本：
 * 文本节点只跑文件引用扫描，裸 URL 只有当模型写成 Markdown `[x](http://…)` 才可点。
 * 这里钉住三件事：正文裸 URL、inline code 里的 URL、以及 URL 优先于文件引用。
 */
test("正文文本节点会把裸 URL 渲染成可点链接", () => {
  assert.match(transcript, /findChatLinks\(text\)/);
  assert.match(transcript, /segment\.type === "url" && segment\.url/);
  assert.match(transcript, /function ExternalLink\(/);
  // 系统浏览器由主进程的 setWindowOpenHandler 接手，渲染层只需 target=_blank。
  assert.match(transcript, /target="_blank"/);
});

test("inline code 里的 URL 也可点", () => {
  assert.match(transcript, /const codeUrl = parseLinkableUrl\(raw\);/);
  assert.match(transcript, /href=\{codeUrl\}/);
});

test("URL 与文件引用由同一套分段给出，URL 优先", () => {
  assert.match(links, /export function findChatLinks\(/);
  assert.match(links, /spans\.some\(\(span\) => overlaps\(span, candidate\)\)/);
  assert.match(links, /export function parseLinkableUrl\(/);
});
