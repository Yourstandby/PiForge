import test from "node:test";
import assert from "node:assert/strict";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { normalizeMarkdownSource } from "./markdown-source.ts";

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

function inline(source: string): MdNode[] {
  const paragraph = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }).children[0] as unknown as MdNode;
  return paragraph.children ?? [];
}

test("**url**： 不再被裸链接吞掉，粗体正常闭合", () => {
  const nodes = inline(normalizeMarkdownSource("**http://127.0.0.1:9200/_xerj-console/**： 刚刚实测返回 200"));
  const strong = nodes[0];
  assert.ok(strong);
  assert.equal(strong.type, "strong");
  const link = strong.children?.[0];
  assert.ok(link);
  assert.equal(link.type, "link");
  assert.equal(link.url, "http://127.0.0.1:9200/_xerj-console/");
  const tail = nodes[1];
  assert.ok(tail);
  assert.equal(tail.value, "： 刚刚实测返回 200");
});

test("中文紧跟裸 URL 时不会被吞进 href", () => {
  const nodes = inline(normalizeMarkdownSource("见 http://127.0.0.1:9200/api，然后继续"));
  const link = nodes.find((node) => node.type === "link");
  assert.ok(link);
  assert.equal(link.url, "http://127.0.0.1:9200/api");
  const tail = nodes[nodes.length - 1];
  assert.ok(tail);
  assert.equal(tail.value, "，然后继续");
});

test("正常裸 URL 保持原样（不额外加尖括号）", () => {
  const source = "see http://a.com/x and more";
  assert.equal(normalizeMarkdownSource(source), source);
});

test("围栏代码块与行内代码不受影响", () => {
  const fenced = "\`\`\`\n**http://a.com/x/**： hi\n\`\`\`";
  assert.equal(normalizeMarkdownSource(fenced), fenced);
  const inlineCode = "\`**http://a.com/x/**：\`";
  assert.equal(normalizeMarkdownSource(inlineCode), inlineCode);
});

test("已有链接与尖括号 autolink 不重复包裹", () => {
  const md = "[文档](http://a.com/x)：说明";
  assert.equal(normalizeMarkdownSource(md), md);
  const autolink = "**<http://a.com/x>**：好";
  assert.equal(normalizeMarkdownSource(autolink), autolink);
});

test("幂等：二次规范化不再改动", () => {
  const once = normalizeMarkdownSource("**http://a.com/x/**： 好");
  assert.equal(normalizeMarkdownSource(once), once);
});
