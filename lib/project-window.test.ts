import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectWindowPath,
  isAbsolutePath,
  parseCwdParam,
  resolveInitialView,
} from "./project-window.ts";

test("parseCwdParam accepts absolute Windows, UNC and POSIX paths", () => {
  assert.equal(parseCwdParam("D:\\Pi\\PiForge"), "D:\\Pi\\PiForge");
  assert.equal(parseCwdParam("C:/Users/dev/project"), "C:/Users/dev/project");
  assert.equal(parseCwdParam("\\\\server\\share\\repo"), "\\\\server\\share\\repo");
  assert.equal(parseCwdParam("/home/dev/repo"), "/home/dev/repo");
});

test("parseCwdParam trims quotes and trailing separators", () => {
  assert.equal(parseCwdParam('"D:\\Pi\\PiForge\\"'), "D:\\Pi\\PiForge");
  assert.equal(parseCwdParam("  D:/Pi/PiForge/  "), "D:/Pi/PiForge");
});

test("parseCwdParam rejects relative or missing values", () => {
  assert.equal(parseCwdParam(null), null);
  assert.equal(parseCwdParam(""), null);
  assert.equal(parseCwdParam("   "), null);
  assert.equal(parseCwdParam("PiForge"), null);
  assert.equal(parseCwdParam("./relative"), null);
  assert.equal(parseCwdParam("https://example.com"), null);
});

test("isAbsolutePath only matches rooted paths", () => {
  assert.equal(isAbsolutePath("D:\\x"), true);
  assert.equal(isAbsolutePath("relative\\x"), false);
  assert.equal(isAbsolutePath("//server/share"), true);
});

test("buildProjectWindowPath percent-encodes the cwd", () => {
  assert.equal(
    buildProjectWindowPath("D:\\Pi Forge\\a&b"),
    "/?cwd=D%3A%5CPi%20Forge%5Ca%26b",
  );
});

test("resolveInitialView prefers ?cwd= so a project window never pops the newest transcript", () => {
  const sessions = [
    { id: "abc", cwd: "D:\\Newest" },
    { id: "def", cwd: "D:\\Older" },
  ];
  assert.deepEqual(
    resolveInitialView("?cwd=D%3A%5CPicked%5CRepo&session=abc", sessions),
    { kind: "project", cwd: "D:\\Picked\\Repo" },
  );
});

test("resolveInitialView opens ?session= when no cwd is given", () => {
  const sessions = [
    { id: "abc", cwd: "D:\\Newest" },
    { id: "def", cwd: "D:\\Older" },
  ];
  assert.deepEqual(resolveInitialView("?session=def", sessions), {
    kind: "session",
    session: { id: "def", cwd: "D:\\Older" },
  });
  assert.deepEqual(resolveInitialView("?session=missing", sessions), {
    kind: "recent",
    cwd: "D:\\Newest",
  });
});

test("resolveInitialView falls back to the newest project", () => {
  assert.deepEqual(resolveInitialView("", []), { kind: "recent", cwd: null });
  assert.deepEqual(resolveInitialView("?cwd=relative", [{ id: "abc", cwd: "D:\\Newest" }]), {
    kind: "recent",
    cwd: "D:\\Newest",
  });
});
