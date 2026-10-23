import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  PI_CORE_PACKAGE,
  PI_CORE_RELEASE_URL,
  buildNpmInstallArgs,
  extractPiCoreTarball,
  installPiCoreVersion,
  isDirectoryWritable,
  isValidPiCoreVersion,
  parseTar,
  piCoreTarballUrls,
  readInstalledPiCoreVersion,
  resolvePiCoreTarget,
} from "./pi-core-update.ts";

// --- 构造真实 tar.gz，验证解包链路不靠 mock -------------------------------

function tarEntry(name: string, content: Buffer, typeflag = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8);
  header.write("0000000\0", 108, 8);
  header.write("0000000\0", 116, 8);
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  header.write("00000000000\0", 136, 12);
  header.write("        ", 148, 8);
  header.write(typeflag, 156, 1);
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, pad]);
}

function makeTarball(version: string): Buffer {
  const tar = Buffer.concat([
    tarEntry("package/package.json", Buffer.from(JSON.stringify({ name: PI_CORE_PACKAGE, version }))),
    tarEntry("package/dist/index.js", Buffer.from("export const v = 1;\n")),
    tarEntry("package/bin/pi", Buffer.from("#!/usr/bin/env node\n")),
    Buffer.alloc(1024),
  ]);
  return gzipSync(tar);
}

function fakeFetch(body: Buffer | null, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => body ?? new ArrayBuffer(0),
  })) as unknown as typeof fetch;
}

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "piforge-picore-"));
}

// --- 基础逻辑 -------------------------------------------------------------

test("resolvePiCoreTarget：打包版装到 standalone，开发版装到仓库根", () => {
  assert.deepEqual(
    resolvePiCoreTarget({ isPackaged: true, appPath: "C:/app/repo", resourcesPath: "C:/app/out/resources" }),
    { dir: path.join("C:/app/out/resources", "standalone"), mode: "standalone" },
  );
  assert.deepEqual(
    resolvePiCoreTarget({ isPackaged: false, appPath: "C:/app/repo", resourcesPath: "ignored" }),
    { dir: "C:/app/repo", mode: "repo" },
  );
});

test("isValidPiCoreVersion 挡住 npm spec 注入", () => {
  for (const bad of ["1.4.0 && rm -rf /", "latest", "1.4", "", "1.4.0;sh", "^1.4.0"]) {
    assert.equal(isValidPiCoreVersion(bad), false);
  }
  assert.equal(isValidPiCoreVersion("1.4.0"), true);
  assert.equal(isValidPiCoreVersion("1.4.0-beta.2"), true);
});

test("buildNpmInstallArgs：repo 精确锁版本，packaged 不写 package.json", () => {
  assert.deepEqual(buildNpmInstallArgs("1.4.0", { dir: "/repo", mode: "repo" }), [
    "install",
    `${PI_CORE_PACKAGE}@1.4.0`,
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    "--save-exact",
  ]);
  assert.equal(buildNpmInstallArgs("1.1.0", { dir: "/out", mode: "standalone" }).at(-1), "--no-save");
});

test("piCoreTarballUrls 指向 registry tarball（npmjs + npmmirror）", () => {
  const urls = piCoreTarballUrls("1.4.0");
  assert.equal(urls.length, 2);
  assert.match(urls[0], /^https:\/\/registry\.npmjs\.org\/@earendil-works%2Fpi-coding-agent\/-\/pi-coding-agent-1\.4\.0\.tgz$/);
  assert.match(urls[1], /^https:\/\/registry\.npmmirror\.com\//);
});

test("parseTar 认得 ustar 头与字节尺寸", () => {
  const entries = parseTar(gunzipSync(makeTarball("9.9.9")));
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["package/package.json", "package/dist/index.js", "package/bin/pi"],
  );
  assert.equal(entries[2].body.toString().trim(), "#!/usr/bin/env node");
});

test("isDirectoryWritable：普通目录 true，路径被文件占位时 false", () => {
  const dir = makeTmpDir();
  try {
    assert.equal(isDirectoryWritable(dir), true);
    const file = path.join(dir, "occupied");
    writeFileSync(file, "x");
    assert.equal(isDirectoryWritable(path.join(file, "child")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extractPiCoreTarball：剥掉 package/ 前缀并原子替换旧版本", () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
    writeFileSync(
      path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "stale.txt"),
      "old",
    );
    extractPiCoreTarball(makeTarball("1.4.0"), dir, "1.4.0");
    assert.equal(readInstalledPiCoreVersion(dir), "1.4.0");
    const pkgDir = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    assert.equal(readFileSync(path.join(pkgDir, "dist", "index.js"), "utf8").trim(), "export const v = 1;");
    assert.throws(() => readFileSync(path.join(pkgDir, "stale.txt"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extractPiCoreTarball 拒绝版本不符的包", () => {
  const dir = makeTmpDir();
  try {
    assert.throws(() => extractPiCoreTarball(makeTarball("1.1.0"), dir, "1.4.0"), /版本不符/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 安装主流程 -----------------------------------------------------------

test("installPiCoreVersion：无 npm 也能装（tarball 通道）", async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { [PI_CORE_PACKAGE]: "1.1.0" } }, null, 2),
    );
    let spawned = 0;
    const result = await installPiCoreVersion({
      version: "1.4.0",
      target: { dir, mode: "repo" },
      fetchImpl: fakeFetch(makeTarball("1.4.0")),
      spawnImpl: (() => {
        spawned += 1;
        throw new Error("不该调用 npm");
      }) as never,
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "tarball");
    assert.equal(result.installed, "1.4.0");
    assert.equal(spawned, 0);
    assert.match(readFileSync(path.join(dir, "package.json"), "utf8"), /"1\.4\.0"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installPiCoreVersion：网络全挂且禁用 npm 兜底 → failure=network + 安装包链接", async () => {
  const dir = makeTmpDir();
  try {
    const result = await installPiCoreVersion({
      version: "1.4.0",
      target: { dir, mode: "standalone" },
      fetchImpl: fakeFetch(null, 503),
      allowNpmFallback: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, "network");
    assert.equal(result.releaseUrl, PI_CORE_RELEASE_URL);
    assert.match(result.error ?? "", /下载失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installPiCoreVersion：网络挂 + npm 也缺 → failure=npm-missing（不崩）", async () => {
  const dir = makeTmpDir();
  try {
    const fakeSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        const error = Object.assign(new Error("spawn npm.cmd ENOENT"), { code: "ENOENT" });
        child.emit("error", error);
      }, 5);
      return child;
    }) as never;

    const result = await installPiCoreVersion({
      version: "1.4.0",
      target: { dir, mode: "standalone" },
      fetchImpl: fakeFetch(null, 500),
      spawnImpl: fakeSpawn,
      env: { NODE_ENV: "test" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, "npm-missing");
    assert.match(result.error ?? "", /没有 npm/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installPiCoreVersion：Windows shell 下 npm 缺失（非零退出 + 中文报错）也归到 npm-missing", async () => {
  const dir = makeTmpDir();
  try {
    const fakeSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        child.stderr.emit("data", Buffer.from("'npm' 不是内部或外部命令，也不是可运行的程序\r\n"));
        child.emit("close", 1);
      }, 5);
      return child;
    }) as never;

    const result = await installPiCoreVersion({
      version: "1.4.0",
      target: { dir, mode: "standalone" },
      fetchImpl: fakeFetch(null, 500),
      spawnImpl: fakeSpawn,
      env: { NODE_ENV: "test" },
    });
    assert.equal(result.failure, "npm-missing");
    assert.equal(result.releaseUrl, PI_CORE_RELEASE_URL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installPiCoreVersion：tarball 挂了但 npm 成功 → via=npm", async () => {
  const dir = makeTmpDir();
  try {
    const fakeSpawn = ((_cmd: string, _args: string[], opts: { cwd: string }) => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        const pkgDir = path.join(opts.cwd, "node_modules", "@earendil-works", "pi-coding-agent");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: PI_CORE_PACKAGE, version: "1.4.0" }));
        child.emit("close", 0);
      }, 5);
      return child;
    }) as never;

    const result = await installPiCoreVersion({
      version: "1.4.0",
      target: { dir, mode: "standalone" },
      fetchImpl: fakeFetch(null, 500),
      spawnImpl: fakeSpawn,
      env: { NODE_ENV: "test" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "npm");
    assert.equal(result.installed, "1.4.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installPiCoreVersion：安装目录不可写 → failure=readonly，不发起下载", async () => {
  const dir = makeTmpDir();
  try {
    const blocker = path.join(dir, "file");
    writeFileSync(blocker, "x");
    let fetched = 0;
    const result = await installPiCoreVersion({
      version: "1.4.0",
      target: { dir: path.join(blocker, "standalone"), mode: "standalone" },
      fetchImpl: (async () => {
        fetched += 1;
        return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
      }) as unknown as typeof fetch,
    });
    assert.equal(result.failure, "readonly");
    assert.equal(fetched, 0);
    assert.match(result.error ?? "", /不可写/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installPiCoreVersion：版本号非法直接拒绝", async () => {
  const result = await installPiCoreVersion({
    version: "1.4.0; rm -rf /",
    target: { dir: tmpdir(), mode: "standalone" },
    allowNpmFallback: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "version");
});
