import test from "node:test";
import assert from "node:assert/strict";
import { buildReferenceInsertion, isImageFileLike } from "./composer-files.ts";

test("isImageFileLike prefers the mime type", () => {
  assert.equal(isImageFileLike("blob", "image/png"), true);
  assert.equal(isImageFileLike("photo.PNG", ""), true);
  assert.equal(isImageFileLike("diagram.svg", undefined), true);
  assert.equal(isImageFileLike("main.ts", "text/plain"), false);
  assert.equal(isImageFileLike("Makefile", ""), false);
});

test("buildReferenceInsertion appends refs with one separating space", () => {
  assert.equal(buildReferenceInsertion("", ["src/app.ts"]), "@src/app.ts ");
  assert.equal(buildReferenceInsertion("fix this", ["src/app.ts"]), "fix this @src/app.ts ");
  assert.equal(buildReferenceInsertion("fix this\n", ["src/app.ts"]), "fix this\n@src/app.ts ");
  assert.equal(
    buildReferenceInsertion("@src/app.ts ", ["src/app.ts"]),
    "@src/app.ts ",
    "already referenced paths are not duplicated",
  );
});

test("buildReferenceInsertion handles multiple paths and blanks", () => {
  assert.equal(
    buildReferenceInsertion("look", ["a.ts", "  ", "b/c.ts"]),
    "look @a.ts @b/c.ts ",
  );
  assert.equal(buildReferenceInsertion("look", ["a.ts", "a.ts"]), "look @a.ts ");
  assert.equal(buildReferenceInsertion("look", []), "look");
  assert.equal(buildReferenceInsertion("look", ["   "]), "look");
});
