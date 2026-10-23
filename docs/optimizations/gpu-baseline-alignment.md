# B 项：gpu 进程 230–259 MB 的归因与收敛（版本对齐 + feature 矩阵）

> 全部数字来自本机实测。B 的目标是 `gpu ≤150 MB`（PAD 0.4.0 实测 152 MB）。

## 1. 对齐 PAD：能拿到什么、拿不到什么

| 想对齐的东西 | 本机能否取到 | 证据 |
|---|---|---|
| PAD 的 `process.versions`（Electron/Chromium/Node） | ❌ 运行时取不到 | 本机**没有** PAD 的安装（`Program Files` / `AppData\Local\Programs` / 卸载注册表 / `AppData\Roaming\pi-agent-desktop` 都没有），也没有残留进程 |
| PAD 的 GPU command line | ✅ 用源码对齐 | `D:\Pi\_ref` = Chasen-Liao/pi-agent-desktop **v0.11.0**（shallow clone，无 0.4.0 历史）：`electron: ^43.7.7`，`electron/main.ts` 里**没有任何** `app.commandLine.appendSwitch` / `disableHardwareAcceleration` / `--use-angle`，窗口同样是 1400×900 + `titleBarStyle: "hidden"` + `titleBarOverlay` |
| PiForge 的运行时版本 | ✅ 已落盘 | 新增启动日志 `Runtime versions`：**Electron 43.8.3 / Chromium 150.0.7871.250 / Node 24.22.0 / V8 15.0.245.31-electron.0**，`gpuSwitches: []` |

结论：**不是版本/开关差异**。两边同一个 Electron 大版本、同一套默认 Chromium 开关。

## 2. 真正的原因：这台机器的硬件加速根本不可用

PiForge 启动日志（`app.getGPUFeatureStatus()`，实测原文）：

```json
{ "gpu_compositing": "disabled_software", "opengl": "disabled_off",
  "rasterization": "disabled_software", "2d_canvas": "disabled_software",
  "webgl": "disabled_off", "webgpu": "disabled_off" }
```

加上 `--ignore-gpu-blocklist` 后依然全部 `disabled_*` —— 这是**远程会话 / 虚拟机**里
Chromium 的典型行为：合成与光栅化都在软件路径上。既然硬件加速不可用，**GPU 进程
仍然会去枚举 GL/Vulkan、初始化 ANGLE 与 shader cache**，这部分就是那 ~100 MB。

## 3. feature / 开关矩阵（本机实测，打包版 + 隔离 userData，8s 采样）

| 变体 | gpu RSS | renderer | 总 RSS | 空闲 CPU | UI 冒烟 |
|---|---|---|---|---|---|
| 基线（Chromium 默认） | **254.7 MB** | 129.7 | 951.5 MB | 1.08% | ✅ |
| `--disable-gpu` | **155.7 MB** | 160.8 | **875.5 MB** | 0.55% | ✅ |
| `app.disableHardwareAcceleration()` | 155.5 MB | 160.2 | 874.6 MB | 1.78% | ✅ |
| `--in-process-gpu` | **无 gpu 进程**（4 个进程） | 128.0 | 891.8 MB | 0.00% | ✅ |
| `--use-angle=swiftshader` | 224.5 MB | 129.3 | 923.7 MB | 0.18% | — |
| `--ignore-gpu-blocklist` | 254.2 MB | 129.5 | 969.7 MB | 0.53% | — |
| `--disable-gpu --disable-gpu-compositing` | 155.5 MB | 161.7 | 872.3 MB | 0.51% | — |
| `--disable-gpu --disable-gpu-rasterization` | 155.4 MB | 158.5 | 871.4 MB | 0.00% | — |

三点结论：

1. **155 MB 是这台机器上"有 gpu 进程"的地板**（4 种组合都落在这里），再往下只能像
   `--in-process-gpu` 那样把 GPU 工作并进 main（总量反而更高：889–916 MB，main 373 MB）。
2. `--disable-gpu` 在**硬件加速不可用**的机器上是纯赚：gpu −99 MB、renderer +31 MB、
   总量 **−76 MB**、CPU 不升反降。
3. 在**硬件加速可用**的机器上 `--disable-gpu` 有害（强制软件合成）。所以不能写死。

## 4. 落地：自适应（只在"已经用不上硬件加速"时才切）

新增 `electron/gpu-preference.ts`（纯函数 + 10 个单测）：

- 每轮启动把 `getGPUFeatureStatus().gpu_compositing` 写进
  `<userData>/gpu-evidence.json`；
- **连续 2 次**观察到 `disabled_software` 才在**下一轮启动前**追加 `--disable-gpu`
  （第一次误判不会生效；硬件正常时证据是 `enabled`，计数清零）；
- 证据 **30 天过期**（换机器/换会话类型能自愈）；
- `PIFORGE_GPU_MODE=default|nogpu|inprocess` 可强制覆盖（排障 / 实验）。

实测（同一干净 userData，连续启动；10s 采样 / settle 15s）：

| 启动 | mode | gpu RSS | renderer | 总 RSS | 空闲 CPU |
|---|---|---|---|---|---|
| 第 1 次 | default（首次，计数 1/2） | 254.4 MB | 126.1 | 937.1 MB | 1.44% |
| 第 2 次 | default（计数 2/2） | 256.3 MB | 129.2 | 951.6 MB | 1.21% |
| 第 3 次 | **nogpu** | **154.1 MB** | 158.6 | **866.4 MB** | 2.23% |
| 第 3 次后 ×3 复测 | nogpu | **153.8 / 154.0 / 156.3** | 160.2 / 162.1 / 165.3 | 875–883 MB | **1.26 / 0.61 / 1.38%** |

## 5. 判定与需要你决定的选项

- 目标 `gpu ≤150 MB`：实测 **153.8–156.3 MB，差 4–6 MB**。
  注意**这个目标线低于 PAD 自己的 152 MB**，因此严格意义上的"≤150"在本机不可达
  （除非把 GPU 进程整个并进 main，而那样总内存反而更高）。
- 相对 PAD 的 152 MB：**+2 MB（+1.3%）**，可以认为对齐。
- 总内存：951.5 → **875.5 MB（−76 MB）**；空闲 CPU 仍在 ≤3% 预算内。

| 选项 | 效果 | 风险 | 建议 |
|---|---|---|---|
| **A. 保留自适应（当前实现，默认开启）** | 软件合成的机器 gpu −100 MB / 总 −76 MB；硬件机器完全不变 | 仅依赖"连续 2 次软件合成"的证据；有 30 天过期 + 环境变量覆盖 | ✅ 推荐 |
| B. 默认关闭（`PIFORGE_GPU_MODE=default` 写进设置页开关） | 等同基线（gpu 255 MB） | 无 | 如果你不接受任何"自动切开关"的行为 |
| C. `--in-process-gpu` | 无 gpu 进程（指标结构性达标） | main 373 MB、GPU 崩溃会带走主进程 | ❌ 不推荐 |
| D. 降/升 Electron 版本 | 无收益（PAD 同版本段） | 全量回归 | ❌ 无依据 |
| E. 接受基线、B 关闭 | gpu 255 MB | 与 PAD 差 100 MB | 仅在你看重"零自动开关"时 |

> 说明：本轮**没有**改 Electron 版本（无证据支持）；也没有把 `--disable-gpu` 写死。
