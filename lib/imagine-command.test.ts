import test from "node:test";
import assert from "node:assert/strict";
import { buildImagineMessage, isImagineCommand, IMAGINE_COMMAND } from "./imagine-command.ts";

test("isImagineCommand recognizes the command and its prompt form", () => {
  assert.equal(IMAGINE_COMMAND, "/imagine");
  assert.equal(isImagineCommand("/imagine"), true);
  assert.equal(isImagineCommand("/imagine a cat"), true);
  assert.equal(isImagineCommand("  /IMAGINE neon city  "), true);
  assert.equal(isImagineCommand("/imagineer"), false);
  assert.equal(isImagineCommand("please /imagine a cat"), false);
  assert.equal(isImagineCommand(""), false);
});

test("buildImagineMessage rewrites the command into a generate_image instruction", () => {
  assert.equal(buildImagineMessage("draw a cat"), null);
  assert.equal(buildImagineMessage("/imagine"), "");
  assert.equal(buildImagineMessage("/imagine   "), "");

  const message = buildImagineMessage("/imagine a cat reading a book, watercolor");
  assert.ok(message);
  assert.match(message, /generate_image/);
  assert.match(message, /a cat reading a book, watercolor/);
  assert.doesNotMatch(message, /^\/imagine/);
});

test("buildImagineMessage keeps the prompt text verbatim", () => {
  const prompt = "赛博朋克城市夜景，霓虹灯，湿漉漉的街道，广角镜头";
  const message = buildImagineMessage(`/imagine ${prompt}`);
  assert.ok(message?.includes(prompt));
});
