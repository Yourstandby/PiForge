import test from "node:test";
import assert from "node:assert/strict";
import {
  ARCHIVE_KEEP,
  archiveFileName,
  createSnapshot,
  formatBytes,
  isUpdateSupported,
  parseArchiveVersion,
  reduceUpdate,
  selectArchivesToDelete,
  shouldEmitProgress,
  unsupportedSnapshot,
  type UpdateSnapshot,
} from "./app-update.ts";

test("createSnapshot 初始为 idle 且不 busy", () => {
  const snapshot = createSnapshot(1_000);
  assert.equal(snapshot.phase, "idle");
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.version, null);
  assert.equal(snapshot.changedAt, 1_000);
});

test("unsupportedSnapshot 明确标记不支持，避免 UI 空白", () => {
  assert.equal(unsupportedSnapshot(5).phase, "unsupported");
  assert.equal(unsupportedSnapshot(5).changedAt, 5);
});

test("available → downloading → downloaded 的相位迁移", () => {
  let snapshot = reduceUpdate(createSnapshot(), { type: "available", version: "0.8.3", at: 1 });
  assert.equal(snapshot.phase, "available");
  assert.equal(snapshot.version, "0.8.3");

  snapshot = reduceUpdate(snapshot, { type: "download-start", at: 2 });
  assert.equal(snapshot.phase, "downloading");
  assert.equal(snapshot.percent, 0);
  assert.equal(snapshot.busy, true);

  snapshot = reduceUpdate(snapshot, {
    type: "download-progress",
    percent: 42.46,
    bytesPerSecond: 2_500_000,
    totalBytes: 12_000_000,
    at: 3,
  });
  assert.equal(snapshot.percent, 42.5, "进度保留一位小数");
  assert.equal(snapshot.bytesPerSecond, 2_500_000);

  snapshot = reduceUpdate(snapshot, { type: "downloaded", version: "0.8.3", at: 4 });
  assert.equal(snapshot.phase, "downloaded");
  assert.equal(snapshot.percent, 100);
  assert.equal(snapshot.busy, false);
});

test("下载中重复的 available / not-available 不会把进度打回起点", () => {
  const downloading: UpdateSnapshot = {
    ...createSnapshot(),
    phase: "downloading",
    version: "0.8.3",
    percent: 60,
    busy: true,
  };
  assert.equal(reduceUpdate(downloading, { type: "available", version: "0.8.3", at: 9 }), downloading);
  assert.equal(
    reduceUpdate(downloading, { type: "not-available", version: null, at: 9 }),
    downloading,
  );
});

test("error 保留可重试的结论，不残留 busy", () => {
  const snapshot = reduceUpdate(
    { ...createSnapshot(), phase: "downloading", busy: true },
    { type: "error", message: "下载停滞超过 20 秒（网络中断？），可重试", at: 7 },
  );
  assert.equal(snapshot.phase, "error");
  assert.equal(snapshot.busy, false);
  assert.match(snapshot.error ?? "", /停滞/);
});

test("check-start 遇到 downloading / downloaded 时让位", () => {
  const downloaded = { ...createSnapshot(), phase: "downloaded" as const, version: "0.8.3" };
  assert.equal(reduceUpdate(downloaded, { type: "check-start", at: 3 }), downloaded);
});

test("shouldEmitProgress：整百分点或超过 400ms 才广播", () => {
  const prev: UpdateSnapshot = {
    ...createSnapshot(0),
    phase: "downloading",
    percent: 10,
    changedAt: 1_000,
  };
  assert.equal(
    shouldEmitProgress(prev, { ...prev, percent: 10.2, changedAt: 1_100 }),
    false,
    "不足 1% 且不足 400ms → 丢帧",
  );
  assert.equal(shouldEmitProgress(prev, { ...prev, percent: 11.1, changedAt: 1_100 }), true);
  assert.equal(shouldEmitProgress(prev, { ...prev, percent: 10.1, changedAt: 1_500 }), true);
  assert.equal(
    shouldEmitProgress({ ...prev, phase: "available" }, { ...prev, percent: 0 }),
    true,
    "非下载阶段一律广播",
  );
  assert.equal(shouldEmitProgress(prev, { ...prev, percent: 100, changedAt: 1_100 }), true);
});

test("isUpdateSupported 必须同时满足打包 + 更新源存在", () => {
  assert.equal(isUpdateSupported({ isPackaged: true, hasFeedFile: true }), true);
  assert.equal(isUpdateSupported({ isPackaged: true, hasFeedFile: false }), false);
  assert.equal(isUpdateSupported({ isPackaged: false, hasFeedFile: true }), false);
});

test("留档文件命名可往返解析，且不误删陌生文件", () => {
  assert.equal(archiveFileName("0.8.3"), "PiForge-0.8.3.exe");
  assert.equal(parseArchiveVersion("PiForge-0.8.3.exe"), "0.8.3");
  assert.equal(parseArchiveVersion("notes.txt"), null);
  assert.equal(parseArchiveVersion("PiForge-.exe"), null);
  const toDelete = selectArchivesToDelete(
    [
      { name: "PiForge-0.8.1.exe", mtimeMs: 10 },
      { name: "PiForge-0.8.2.exe", mtimeMs: 20 },
      { name: "PiForge-0.8.3.exe", mtimeMs: 30 },
      { name: "PiForge-0.8.4.exe", mtimeMs: 40 },
      { name: "keep-me.txt", mtimeMs: 1 },
    ],
    ARCHIVE_KEEP,
  );
  assert.deepEqual(toDelete, ["PiForge-0.8.1.exe"], "只淘汰最旧的安装包，忽略非安装包");
});

test("formatBytes 用于进度文案", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1024 * 1024 * 2.5), "2.5 MB");
});
