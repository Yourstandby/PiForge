import test from "node:test";
import assert from "node:assert/strict";
import {
  attachSessionStream,
  getSessionStreamSeq,
  resetSessionStreamsForTest,
  subscribeSessionStream,
  type StreamEvent,
  type SessionStreamSource,
} from "./session-events.ts";

test.beforeEach(() => resetSessionStreamsForTest());
test.afterEach(() => resetSessionStreamsForTest());

function createSource(sessionId = "s1") {
  let listener: ((event: StreamEvent) => void) | null = null;
  let onDestroy: (() => void | Promise<void>) | null = null;
  const source: SessionStreamSource = {
    sessionId,
    onEvent(cb) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    onDestroy(cb) {
      onDestroy = cb;
    },
  };
  return {
    source,
    emit(event: StreamEvent) {
      listener?.(event);
    },
    destroy() {
      onDestroy?.();
    },
  };
}

test("subscribing with no cursor replays everything not yet delivered", () => {
  const fake = createSource();
  attachSessionStream(fake.source);
  fake.emit({ type: "one" });
  fake.emit({ type: "two" });

  const seen: Array<[number, string]> = [];
  const sub = subscribeSessionStream("s1", undefined, (event, seq) => {
    seen.push([seq, event.type as string]);
  });
  assert.ok(sub);
  assert.equal(sub.lastSeq, 2);
  assert.deepEqual(seen, [], "replay is deferred so the client can map the subscription id");

  sub.activate();
  assert.deepEqual(seen, [[1, "one"], [2, "two"]]);
  sub.unsubscribe();
});

test("reconnect resumes after the last delivered sequence (Next restart)", () => {
  const fake = createSource();
  attachSessionStream(fake.source);
  fake.emit({ type: "one" });
  fake.emit({ type: "two" });

  const first: number[] = [];
  const sub1 = subscribeSessionStream("s1", undefined, (_event, seq) => first.push(seq));
  assert.ok(sub1);
  sub1.activate();
  assert.deepEqual(first, [1, 2]);
  // Simulate the Next connection dying.
  sub1.unsubscribe();

  // The agent keeps running while nobody is connected.
  fake.emit({ type: "three" });
  fake.emit({ type: "four" });

  const resumed: number[] = [];
  const sub2 = subscribeSessionStream("s1", undefined, (_event, seq) => resumed.push(seq));
  assert.ok(sub2);
  sub2.activate();
  assert.deepEqual(resumed, [3, 4]);
  sub2.unsubscribe();
});

test("explicit fromSeq replays from the requested sequence", () => {
  const fake = createSource();
  attachSessionStream(fake.source);
  for (const type of ["one", "two", "three", "four"]) fake.emit({ type });

  const seen: Array<[number, string]> = [];
  const sub = subscribeSessionStream("s1", 2, (event, seq) => {
    seen.push([seq, event.type as string]);
  });
  assert.ok(sub);
  sub.activate();
  assert.deepEqual(seen, [[2, "two"], [3, "three"], [4, "four"]]);
  sub.unsubscribe();
});

test("events published between response and activate are not lost or reordered", () => {
  const fake = createSource();
  attachSessionStream(fake.source);
  fake.emit({ type: "one" });

  const seen: number[] = [];
  const sub = subscribeSessionStream("s1", undefined, (_event, seq) => seen.push(seq));
  assert.ok(sub);
  // A live event arrives while the server is still sending the response.
  fake.emit({ type: "two" });
  assert.deepEqual(seen, []);
  sub.activate();
  assert.deepEqual(seen, [1, 2]);
  sub.unsubscribe();
});

test("attach is idempotent and destroy removes the stream", () => {
  const fake = createSource();
  attachSessionStream(fake.source);
  attachSessionStream(fake.source);
  fake.emit({ type: "one" });
  assert.equal(getSessionStreamSeq("s1"), 1);

  fake.destroy();
  assert.equal(getSessionStreamSeq("s1"), null);
  assert.equal(subscribeSessionStream("s1", undefined, () => {}), null);
});
