import test, { describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { AgentEventsManager, type AgentEvent } from "./agent-events-manager.ts";

class MockEventSource {
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  static instances: MockEventSource[] = [];
}

describe("AgentEventsManager", () => {
  let originalEventSource: typeof globalThis.EventSource;

  beforeEach(() => {
    originalEventSource = globalThis.EventSource;
    (globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource = MockEventSource;
    MockEventSource.instances = [];
  });

  afterEach(() => {
    (globalThis as unknown as { EventSource: typeof globalThis.EventSource }).EventSource = originalEventSource;
  });

  test("connects to the correct URL and parses incoming JSON messages", () => {
    const manager = new AgentEventsManager();
    const events: AgentEvent[] = [];
    manager.setEventHandler((e) => events.push(e));

    manager.connect("session-123");

    assert.equal(MockEventSource.instances.length, 1);
    const es = MockEventSource.instances[0];
    assert.equal(es.url, "/api/agent/session-123/events");
    assert.equal(es.closed, false);
    assert.equal(manager.getStatus(), "connecting");

    // Trigger onopen
    es.onopen!();
    assert.equal(manager.getStatus(), "connected");

    // Send a message
    assert.ok(es.onmessage);
    es.onmessage({ data: JSON.stringify({ type: "agent_start", foo: "bar" }) });

    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { type: "agent_start", foo: "bar" });
  });

  test("handles JSON parsing errors gracefully", () => {
    const manager = new AgentEventsManager();
    const events: AgentEvent[] = [];
    manager.setEventHandler((e) => events.push(e));

    manager.connect("session-123");
    const es = MockEventSource.instances[0];

    // Mock console.error to avoid polluting output
    const originalConsoleError = console.error;
    let loggedError = false;
    console.error = () => { loggedError = true; };

    try {
      es.onmessage!({ data: "invalid json" });
      assert.equal(events.length, 0);
      assert.equal(loggedError, true);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("disconnects and cleans up EventSource on cleanup", () => {
    const manager = new AgentEventsManager();
    manager.connect("session-123");

    const es = MockEventSource.instances[0];
    assert.equal(es.closed, false);

    manager.cleanup();
    assert.equal(es.closed, true);
    assert.equal(manager.getEventSource(), null);
    assert.equal(manager.getStatus(), "disconnected");
  });

  // Reconnect/backoff tests drive the mocked clock instead of sleeping: the
  // production reconnect timer uses global setTimeout, which mock.timers
  // intercepts (same pattern as agent-host/rpc-manager.test.ts). The reconnect
  // callback runs synchronously inside tick(), so instance counts can be
  // asserted immediately afterwards.
  test("auto-reconnects when onerror is triggered and agent is running", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const manager = new AgentEventsManager(10); // 10ms reconnect delay
      manager.setAgentRunning(true);
      manager.connect("session-123");

      assert.equal(MockEventSource.instances.length, 1);
      const es1 = MockEventSource.instances[0];

      // Trigger error — schedules a (mocked) reconnect timer
      es1.onerror!();

      assert.equal(es1.closed, true);
      assert.equal(manager.getEventSource(), null);
      assert.equal(manager.getStatus(), "connecting");

      // Advance the mocked clock past the reconnect delay
      mock.timers.tick(15);

      assert.equal(MockEventSource.instances.length, 2);
      const es2 = MockEventSource.instances[1];
      assert.equal(es2.url, "/api/agent/session-123/events");
      assert.equal(es2.closed, false);

      manager.cleanup();
    } finally {
      mock.timers.reset();
    }
  });

  test("does not reconnect when onerror is triggered but agent is not running", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const manager = new AgentEventsManager(10);
      manager.setAgentRunning(false);
      manager.connect("session-123");

      assert.equal(MockEventSource.instances.length, 1);
      const es1 = MockEventSource.instances[0];

      // Trigger error — no reconnect timer is scheduled
      es1.onerror!();

      assert.equal(es1.closed, true);
      // Advance well past the reconnect delay — nothing may fire
      mock.timers.tick(15);

      assert.equal(MockEventSource.instances.length, 1); // No new EventSource instance created
      assert.equal(manager.getStatus(), "disconnected");
      manager.cleanup();
    } finally {
      mock.timers.reset();
    }
  });

  test("connect expectRunning=true reconnects on an early onerror without a prior setAgentRunning (M4)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const manager = new AgentEventsManager(10);
      // Reproduces the handleSend timing: connectEvents() fires before the
      // [agentRunning] effect has propagated manager.setAgentRunning(true),
      // so agentRunning is still false when onerror arrives. The stream is
      // expected, so an early onerror must reconnect — not silently
      // disconnect and leave the UI stuck on "Waiting for model…".
      manager.connect("session-123", true, true);

      const es1 = MockEventSource.instances[0];
      es1.onerror!();

      assert.equal(es1.closed, true);
      assert.equal(manager.getStatus(), "connecting");

      mock.timers.tick(15);
      assert.equal(MockEventSource.instances.length, 2);
      manager.cleanup();
    } finally {
      mock.timers.reset();
    }
  });

  test("exponential backoff delay doubles on consecutive errors", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const manager = new AgentEventsManager(10); // 10ms base delay
      manager.setAgentRunning(true);
      manager.connect("session-123");

      const es1 = MockEventSource.instances[0];
      es1.onerror!(); // 1st failure -> reconnectAttempts = 1 -> delay 10ms
      assert.equal(manager.getReconnectAttempts(), 1);

      mock.timers.tick(10);
      assert.equal(MockEventSource.instances.length, 2);

      const es2 = MockEventSource.instances[1];
      es2.onerror!(); // 2nd failure -> reconnectAttempts = 2 -> delay 20ms
      assert.equal(manager.getReconnectAttempts(), 2);

      // Advance 12ms (not enough for the 20ms delay)
      mock.timers.tick(12);
      assert.equal(MockEventSource.instances.length, 2);

      // Advance another 12ms (total 24ms, enough for the 20ms delay)
      mock.timers.tick(12);
      assert.equal(MockEventSource.instances.length, 3);

      manager.cleanup();
    } finally {
      mock.timers.reset();
    }
  });

  test("仍会重连但不再永久放弃：超限只标记 failed，后台继续退避重试", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const manager = new AgentEventsManager(5); // 5ms base delay
      manager.setAgentRunning(true);
      manager.connect("session-123");

      // Trigger 5 errors; each reconnect fires on the mocked clock after its
      // exponential delay (5, 10, 20, 40, 80ms).
      for (let i = 0; i < 5; i++) {
        const es = MockEventSource.instances[i];
        assert.ok(es);
        es.onerror!();
        const delay = 5 * Math.pow(2, i) + 10;
        mock.timers.tick(delay);
      }

      // Now MockEventSource.instances should have 6 instances (1 original + 5 reconnects)
      assert.equal(MockEventSource.instances.length, 6);

      // The 6th error will exceed the limit of 5 reconnect attempts
      const es6 = MockEventSource.instances[5];
      es6.onerror!();

      assert.equal(manager.getStatus(), "failed");
      assert.equal(manager.getReconnectAttempts(), 6);

      // 关键行为变更：failed 只代表"该提示用户了"，不代表停止重连。
      // 放弃重连会把"流断了"变成"永远静默"（界面一直显示正在思考）。
      mock.timers.tick(30000 + 10);
      assert.equal(MockEventSource.instances.length, 7);

      manager.cleanup();
    } finally {
      mock.timers.reset();
    }
  });

  test("retryNow() 在 failed 后能立即重连并清零退避", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const manager = new AgentEventsManager(5);
      manager.setAgentRunning(true);
      manager.connect("session-123");

      for (let i = 0; i < 6; i++) {
        MockEventSource.instances[i].onerror!();
        // 最后一次不推进时钟：看清 failed。
        if (i < 5) mock.timers.tick(5 * Math.pow(2, i) + 10);
      }
      assert.equal(manager.getStatus(), "failed");
      const before = MockEventSource.instances.length;

      manager.retryNow();
      assert.equal(MockEventSource.instances.length, before + 1);
      assert.equal(manager.getStatus(), "connecting");
      assert.equal(manager.getReconnectAttempts(), 0);
      assert.equal(MockEventSource.instances.at(-1)!.closed, false);

      manager.cleanup();
    } finally {
      mock.timers.reset();
    }
  });

  test("getLastEventAt() 只在收到真实事件时更新（heartbeat 不算）", () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      mock.timers.tick(1000);
      const manager = new AgentEventsManager();
      manager.connect("session-123");
      const connectedAt = manager.getLastEventAt();
      assert.ok(connectedAt > 0);

      // 服务端 15s 一次 heartbeat 註释帧：EventSource 不触发 onmessage，时间戳不动。
      mock.timers.tick(15_000);
      assert.equal(manager.getLastEventAt(), connectedAt);

      mock.timers.tick(500);
      MockEventSource.instances[0].onmessage!({ data: JSON.stringify({ type: "agent_start" }) });
      assert.equal(manager.getLastEventAt(), Date.now());
      assert.notEqual(manager.getLastEventAt(), connectedAt);

      manager.cleanup();
    } finally {
      mock.timers.reset();
    }
  });
});
