import assert from "node:assert/strict";
import test from "node:test";
import { FollowUpQueue } from "./follow-up-queue.ts";

test("queued follow-ups keep stable ids and can be reordered as the real send order", () => {
  const queue = new FollowUpQueue();

  queue.enqueue({ id: "a", message: "A", createdAt: 1 });
  queue.enqueue({ id: "b", message: "B", createdAt: 2 });
  queue.enqueue({ id: "c", message: "C", createdAt: 3 });

  const reordered = queue.reorder(["c", "a", "b"], 3);

  assert.deepEqual(reordered.items.map((item) => item.id), ["c", "a", "b"]);
  assert.equal(queue.shift()?.item.message, "C");
  assert.equal(queue.shift()?.item.message, "A");
  assert.equal(queue.shift()?.item.message, "B");
});

test("removing a queued follow-up drops exactly that item and rejects stale revisions", () => {
  const queue = new FollowUpQueue();
  queue.enqueue({ id: "a", message: "A", createdAt: 1 });
  queue.enqueue({ id: "b", message: "B", createdAt: 2 });

  assert.throws(() => queue.remove("a", 1), /queue changed/i);
  const remaining = queue.remove("a", 2);

  assert.deepEqual(remaining.items.map((item) => item.id), ["b"]);
  assert.equal(remaining.revision, 3);
  assert.equal(queue.shift()?.item.message, "B");
  assert.throws(() => queue.remove("missing", queue.snapshot().revision), /not found/i);
});

test("a stale reorder cannot overwrite a newer queue and queued images survive dispatch", () => {
  const queue = new FollowUpQueue();
  queue.enqueue({
    id: "image",
    message: "look",
    images: [{ type: "image", data: "base64", mimeType: "image/png" }],
    createdAt: 1,
  });
  queue.enqueue({ id: "text", message: "then this", createdAt: 2 });

  assert.throws(
    () => queue.reorder(["text", "image"], 1),
    /queue changed/i,
  );
  assert.deepEqual(queue.snapshot().items.map((item) => item.id), ["image", "text"]);
  assert.deepEqual(queue.shift()?.item.images, [
    { type: "image", data: "base64", mimeType: "image/png" },
  ]);
});
