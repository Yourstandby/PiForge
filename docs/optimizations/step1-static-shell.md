# 外壳层对齐 PAD：Step 1（拆掉 Next standalone）落地报告

> 目标：启动 / 内存 / 空闲 CPU 向 Pi Agent Desktop（PAD 0.4.0）看齐。
> 全程不改 token 相关机制（`prompt-prefix.ts`、工具域、`smoke:prefix-budget` 一行未动）。
> 所有数字来自本机实测（`PIFORGE_USER_DATA` 隔离实例 + `tasklist/Get-Process` RSS 求和 + 主进程日志时间戳）。

## 0. 结论速览

| 指标 | 0.9.0（拆前，实测） | 本轮（拆后，实测） | PAD 0.4.0 | 目标 | 判定 |
|---|---|---|---|---|---|
| app ready → agent-host ready | 5 562 ms | **1 304 / 1 384 / 1 393 / 2 271 / 2 386 / 2 442 ms**（6 次上限 2.44 s） | 3 700 ms | ≤5 000 ms | ✅ 达成（最好一次比 PAD 快 2.4×） |
| app ready → 窗口可用 | 169 ms | **68–130 ms**（static url loaded 0.40–0.64 s） | 1 300 ms | ≤2 000 ms | ✅ 达成 |
| next-server 进程 | 1 个 / 471.7 MB | **0** | 无 | 消除 | ✅ 达成 |
| `127.0.0.1:30141` 监听 | 有 | **无**（`netstat` 断言在 `measure-packaged` 里） | 无 | 消除 | ✅ 达成 |
| renderer RSS | 387.9 MB | **127.8 / 128.4 / 132.0 MB**（打开真实会话时 129.2 MB） | 153 MB | ≤200 MB | ✅ 达成（优于 PAD） |
| agent-host RSS | 283 MB | 312–374 MB（8 次采样中位 359） | 183 MB | ≤220 MB | ❌ 未达成（见 §4） |
| 总 RSS | 1 813 MB | **863–947 MB**（9 次采样：947 / 934 / 863 / 946 / 914 / 935 / 915 / 865 / 909） | 719–829 MB | ≤900 MB | ⚠️ 临界（中位 915，2/9 次达标；缺口全在 agent-host） |
| 空闲 CPU（10 s 采样，单核口径） | 52.5% | **9.2–10.9%**，其中 agent-host **8.6–10.0%**、main/renderer/gpu 各 ≤0.6%（窗口被遮挡时整机 0.6–1.5%） | 0.2%（0.002 核） | ≤5% | ⚠️ 部分（见 §3/§4） |
| 安装体积（`win-unpacked`） | 723 MB | **581 MB** | 564 MB | ≤650 MB | ✅ 达成 |
| 安装包（NSIS） | — | **163.2 MB**（zip 215.0 MB） | — | — | ✅ |

`smoke:prefix-budget`：**exit 0**，前缀 6 640 tok、稳定段命中率 **99.6%** —— 与改动前逐字节一致（token 面零变化）。

## 1. 新架构（一步到位，不留半套）

```
Renderer ──fetch("/api/**")──▶ piforge://app（自有协议，零 HTTP 监听）
                                   │
                     Electron Main protocol.handle（electron/static-app.ts）
                     ├── /api/**  → AgentHostApiBridge（命名管道 RPC）
                     │                 └── agent-host/api-router.ts
                     │                       └── app/api/**/route.ts（原文件不动）
                     └── 其它     → out/（next build 静态导出 → resources/static）
```

关键取舍：
- **路由文件一行不改**：它们是 Web 标准 `(Request) => Response`，只依赖
  `lib/next-server-shim.ts`（提供 `NextResponse.json` / `NextRequest`）。
- **懒加载**：`agent-host/api-routes.generated.ts`（脚本生成）用 `import()` 按需加载，
  Host 冷启动不替 70 条路由付模块解析成本。
- **流式响应**：`api.request` 返回 `streamId`，随后 `api.stream.chunk` / `api.stream.end`
  事件推送（替代 HTTP SSE）；`text/event-stream` 判定在 Host 侧完成。
- **打包只装运行时要的东西**：`resources/static`（24 MB）+ `resources/standalone/node_modules`
  （192 MB，Pi SDK 闭包）+ `agent-host`（3 MB）。

## 2. Step 1 改动清单

新增
| 文件 | 作用 |
|---|---|
| `lib/next-server-shim.ts` | `NextResponse.json` / `NextRequest` 的最小实现（Next 与 Host 都能用） |
| `electron/static-app.ts` | `piforge://` 处理器：`/api/**` → 管道，其它 → 静态文件；含目录穿越防护与 CSP |
| `electron/api-bridge.ts` | Main ↔ Host 的 `/api` 传输桥（握手、`api.request`、流式块、回 ping） |
| `electron/api-bridge.test.ts` | 4 个用例（RPC、心跳 pong、早到块回放、断链 reject） |
| `electron/static-app.test.ts` | 静态路径解析 / SPA 回退 / 404 / CSP 断言（纯函数） |
| `agent-host/api-router.ts` | 路径匹配（`:id` / `*rest`）、方法分派、404/405 |
| `agent-host/api-routes.generated.ts`（生成） | 70 条路由的懒加载表 |
| `scripts/generate-api-routes.mjs` | 扫 `app/api/**/route.ts` 生成上表（`build:agent-host` 前置） |
| `scripts/next-build.mjs` | `next build` 双模式 wrapper（静态导出 / `--standalone`） |
| `scripts/measure-packaged.mjs` | 打包版实测：启动阶梯 + 角色化 RSS/CPU + 端口断言 |
| `scripts/smoke-packaged-static.mjs` | 打包冒烟：布局断言 + 渲染进程自证 `/api` 打通 |

修改
| 文件 | 改动 |
|---|---|
| `next.config.ts` | 函数式配置：生产构建 `output: "export"` + `distDir: ".next-static"` + `pageExtensions: ["tsx"]`；**dev 保留默认**（`npm run dev` 的 `/api` 仍是 Next 路由，实测 200） |
| `electron/main.ts` | 注册 `piforge` 特权协议；`USE_NEXT_SERVER` 分支（`PIFORGE_USE_NEXT=1` 走旧路径）；`showStaticApp()`；`isAllowedAppUrl` 接受新协议；Host 起来前不阻塞首屏；`PIFORGE_USER_DATA` / `PIFORGE_OPEN_PATH` / `PIFORGE_EXIT_AFTER_MS` / `PIFORGE_DEBUG_API` / `PIFORGE_DISABLE_BROWSER_BRIDGE` / `PIFORGE_SMOKE_FREEZE_CSS` 诊断钩子 |
| `electron/csp.ts` | 新增 `buildStaticAppCspHeader()`：`connect-src 'self' piforge:`（不再开 localhost） |
| `electron-builder.yml` | `resources/static` ← `out/`；删掉 standalone 的 `server.js`/`.next`/`public`；**`!node_modules/**`**（app.asar 80 MB → 2.3 MB） |
| `app/api/**/route.ts`（70 个） | 仅改 import：`next/server` → `lib/next-server-shim.ts`；`@/lib/*`、`@contract/*` → 相对路径（Host 侧 ESM 可直接解析） |
| `lib/api-error.ts`、`lib/next-server-shim.ts` | 用显式 `Headers` 入参类型替代 DOM 的 `HeadersInit`（Host 的 tsconfig 没有 DOM lib） |
| `agent-host/server.ts` | 新增 `api.request` / `api.stream.close`，流式泵 + 连接关闭清理 |
| `contract/methods.ts` | 新方法签名（`api.request` / `api.stream.close`） |
| `lib/git-status.ts` | **单飞 + 3s TTL 缓存** `invalidateGitStatus()`：三条轮询路径不再各自起 worker + 两个 git 进程 |
| `components/FileExplorer.tsx` | 去掉 git status 定时器，改为 `visibilitychange` / `focus` / `refreshKey` 驱动 |
| `components/GitPanel.tsx` | 轮询 12s → 15s（配合 Host 侧缓存） |
| `package.json` | `build` → `build:static`；`build:standalone` 走 wrapper；`pack`/`dist` 先静态再 standalone；新增 `measure:packaged` / `smoke:packaged-static` |
| `docs/ARCHITECTURE.md` | 新增"零内部端口的实现方式"一节 |
| `electron/main-update-gate.test.ts`、`package.test.ts` | 断言更新到新架构（导航必须 `await`、双构建产物） |

## 3. Step 1 过程中靠实测抓到的三个真问题

1. **catch-all 参数类型**：`[...path]` 在 Next 里是 `string[]`，我一开始传了 `"a/b"` 字符串 →
   `/api/files/**` 全部 500（`segments.join is not a function`），文件树为空。已修（含注释）。
2. **`git status` 风暴（空闲 CPU 的主因之一）**：文件树 20 s + Git 面板 12 s + `refreshKey`
   三路并发，每次扫描 = 新建 worker + `git rev-parse` + `git status`，本机实测单次从 250 ms
   恶化到 **2.5–4 s**（git 抢 `index.lock`），全部记在 Host 的 CPU 上。
   修法：Host 侧单飞 + 3 s TTL 缓存；渲染侧去掉定时器。修后日志里再无 >1 s 的 `/api/git/status`。
3. **`next dev` 被静态导出配置带崩**：`pageExtensions: ["tsx"]` 用了 env 判定，dev 也被命中 →
   `/api/health` 404。改成按 Next 的 `phase` 判定（只影响生产构建），dev 复测 200。

## 4. 仍未达标：agent-host（312–374 MB / 6–9% CPU）

**实测证据**
- 单独启动打包版 Host（无任何客户端）：`host_ready = 3 112 ms`，空闲 CPU **0.00%**（10 s 采样）。
- 在应用内：RSS 312–374 MB，CPU **6.2–9.5%**，且 `PIFORGE_DEBUG_API=1` 的慢请求日志里已无
  秒级请求（只剩 `/api/sessions` 280–535 ms、`/api/models` 387 ms 这类启动期一次性调用）。
- 结论：这 6–9% 不是某条路由，而是**Host 现在同时承担了外壳的 API 层**（70 条路由 + 它们的
  `lib/*` 依赖：session-reader、pi-runtime、file-index、config-watcher、git、mcp、skills…），
  也就是原来 Next 那 471.7 MB 进程里"业务粘合层"的那部分搬进了 Host。

**下一步（Step 4，需单独立项）**
1. 先量化：`PIFORGE_DEBUG_HOST_CPU=1`（每 5 s 打印自身 CPU/RSS/活跃句柄）+
   `/api` 请求耗时分布，确认是"模块常驻"还是"某条路径周期性干活"。
2. 把扫描型路由从 Host 移出或改为按需：`/api/sessions`（扫盘）、`/api/models`（目录构建）、
   `/api/usage/upstream`、`/api/file-index`。它们和"Host 只跑 Pi SDK"的边界本来就该分开。
3. 拆包：`agent-host` 编译产物按域分 chunk，路由懒加载已经做了；下一步是把 `lib/pi-runtime`
   这类"只有个别路由需要"的重模块改成动态 `import()`。

## 5. 复现 / 验收命令

```bash
# 1) 构建（两份产物）
npm run build:static        # out/  ← 静态直出
npm run build:standalone    # .next/standalone ← node_modules + agent-host 入口
npm run build:electron

# 2) 打包 + 冒烟（冒烟会断言：无 server.js / 有 index.html / UI 挂载 / /api 打通）
npm run pack

# 3) 实测（隔离 userData，不影响正在用的实例）
node scripts/measure-packaged.mjs --exe release/win-unpacked/PiForge.exe --seconds 10 --settle 15
node scripts/measure-packaged.mjs --exe release/win-unpacked/PiForge.exe --seconds 10 --settle 15 --json
node scripts/measure-packaged.mjs --exe release/win-unpacked/PiForge.exe --series --settle 12   # 看每秒曲线

# 4) token 面未动（必须仍然 exit 0）
npm run smoke:prefix-budget

# 5) 体积
du -sh release/win-unpacked                                  # 581M
ls -la release/PiForge-Setup-0.9.0.exe                       # 163.2 MB
```

## 6. 回退

- **开发迭代**：`npm run dev` 直接用 Next dev server（`/api` 仍是 Next 路由，实测 200）。
- **打包回退旧路径**：`node scripts/next-build.mjs --standalone` + 把 `electron-builder.yml`
  的 `resources/standalone` 整份恢复 + `PIFORGE_USE_NEXT=1` 启动。
  ⚠️ 注意：默认包里**不再包含** `server.js`，所以运行时开关单独用不了 —— 回退是"重新构建 +
  加回 extraResources"，不是纯运行时切换（这一点与最初设想不同，已按实测修正）。
- **代码级回退**：`git revert` 本步的 commit（`app/api/**` 只有 import 变化，恢复成本低）。
