# PiForge UI 重构视觉规范

> 状态：**P1–P4 已落地**（2026-10-19）。P5 截图矩阵已跑通；§10 中 3 项按推荐值执行，
> 第 3 项（空状态锚点）暂用主题色光晕，未启用 BrandLogo。
> 适用范围：PiForge 桌面端全部界面（工作台、会话、文件查看器、配置弹窗、启动页、错误页）。
> 设计语言代号：**Frost Ledger / 霜蓝手记**。

---

## 0. 一句话方向

一个长时间开着、信息密度高的 Agent 工作台：骨架像技术台账（等宽元数据、衬线正文、
发丝分隔线），气质像清晨的冷色玻璃，只保留一处会发光的冰川（空状态 / 思考球）。

三个关键词的落点：

| 关键词 | 具体落点 |
| --- | --- |
| 桌面端 | 36px 工具栏 + 13.5px UI 字号 + 窄行高 + 键盘可达；不用移动端的胶囊按钮和大圆角 |
| 唯美 | 冷色纸感、单一发光体、克制的雾面渐变（**仅冰川主题**）、衬线正文 |
| 蓝色系 | 蓝色不是点缀而是底色：Light 是冷纸、Dark 是石墨（去色）、Glacier 是真正的雾蓝 |

---

## 1. 现状诊断（基于当前工作区截图与 token）

1. **Glacier 与 Dark 几乎无法区分**：`#0b1218` vs `#101215`，两者都是中性近黑；对比度差不足以形成"主题"。
2. **Light 不蓝**：底色是中性灰 `#f2f3f4`，蓝色只存在于 accent。
3. **"Ledger" 过于报纸化**：3/5px 圆角 + 纯发丝 + 无阴影 + 衬线标题，落在"broadsheet"这一 AI 常见套路上；单看很干净，但缺乏"唯美"的质感层。
4. **空状态失去锚点**：Logo 被移除后，只剩一行巨大的衬线 PiForge + 一个白色输入框，缺少视觉重心。
5. **层级靠颜色硬撑**：`--bg-elevated` 在深色下与面板同色，弹层/侧栏/画布无法在不开阴影时区分。
6. **硬编码颜色残留**：`SkillsConfig`(8)、`ThinkingLevelMapEditor`(6)、`ExtensionUiDialog`(4) 等未走 token，主题切换时会漂移。
7. **构建阻塞**：`components/MessageView.tsx:662` 引用了未定义的 `isError`，`tsc --noEmit` 失败，ThinkingBlock 运行时会抛错——视觉验收前必须先修。

---

## 2. 三主题身份（这是本次重构的核心）

| 主题 | 身份 | 底色 | accent | 状态栏/标题栏 |
| --- | --- | --- | --- | --- |
| **霜白 Frost**（light） | 冷调纸面，像 300g 蓝白卡纸 | `#EDF2F8`（L\* 95.3，hue 213） | 钴蓝 `#2B5FD9` | `#F7FAFE` |
| **石墨 Graphite**（dark） | 纯中性石墨，**刻意不带蓝**，让位给 Glacier | `#0E1013`（L\* 4.6） | 靛蓝 `#8C9EFF` | `#0B0D10` |
| **雾蓝 Haze**（glacier） | 清晨雾中的冰川：所有表面都带蓝、有雾、有霜边 | `#172631`（L\* 14.3，hue 205） | 冰青 `#6FD7FF` | `#13212B` |

### 2.1 "一眼区分"的硬指标

| 指标 | Dark | Glacier | 判据 |
| --- | --- | --- | --- |
| 背景 L\* | 4.6 | 14.3 | **ΔL\* ≈ 9.7**（肉眼在暗环境一眼可辨） |
| 背景色相 | 216° / 近零饱和 | 205° / 明显蓝 | 表面有可见蓝灰，不是黑 |
| accent | 靛蓝 `#8C9EFF` | 冰青 `#6FD7FF` | 色相差约 30°，冷感不同 |
| 氛围 | 纯平，无渐变 | 固定雾面 wash + 霜边高光 | Glacier 独有，Dark 不允许出现 |
| 抬升面 | 与面板同色，靠描边 | 逐级变亮（L\* 18.4 → 22.4） | 不看边框也能分出层级 |

> 备选（更浓的"冰川蓝"）：bg `#0B2A3D` + accent `#64E0FF`。更戏剧化，但长时间阅读更累，**默认不推荐**。

### 2.2 Glacier 专属三件套（其余主题禁用）

1. **雾面 wash**：两团固定径向雾，左上 `rgba(46,120,180,0.30)`，右上 `rgba(111,215,255,0.10)`，`background-attachment: fixed`，透明度上限 30%，不得压过文字。
2. **霜边**：所有 `bg-elevated` 面板顶部 1px 内高光 `rgba(180,225,255,0.06)`，模拟冰面反光。
3. **发光体**：空状态 / 思考球的冰青光晕（`#6FD7FF`，blur ≥ 40px，opacity ≤ 0.35）。全应用只允许这一处"发光"。

---

## 3. 颜色 Token

### 3.1 霜白 Frost

| Token | 值 | 用途 |
| --- | --- | --- |
| bg | `#EDF2F8` | 画布 |
| bg-panel | `#E4EBF3` | 侧栏 / 分区 |
| bg-elevated | `#FFFFFF` | 弹层 / 查看器 |
| bg-hover / selected | `#E0E8F1` / `#D5E0EE` | 交互态 |
| border / subtle | `#CBD7E4` / `#DDE5EE` | 发丝 |
| text / strong / muted / dim | `#24303F` / `#0F1A26` / `#566576` / `#7A8A9C` | 对比：11.9 / 5.3 / 3.1（dim 仅元数据） |
| accent / hover / contrast | `#2B5FD9` / `#1E4DBA` / `#FFFFFF` | 对比 5.0 |
| user-bg / border | `#E3ECF9` / `#C4D6EE` | 用户引用块底 |
| code-bg / header | `#F5F8FC` / `#E9EFF6` | 代码 |
| success / danger / warning / info | `#1D7A50` / `#B3352E` / `#8A5A12` / `#1F63C7` | 语义 |

### 3.2 石墨 Graphite

| Token | 值 | 用途 |
| --- | --- | --- |
| bg | `#0E1013` | 画布 |
| bg-panel | `#15181C` | 侧栏 |
| bg-elevated | `#1A1E23` | 弹层 |
| bg-hover / selected | `#1E2228` / `#262B32` | 交互态 |
| border / subtle | `#2A3037` / `#1E2329` | 发丝 |
| text / strong / muted / dim | `#C7CCD3` / `#F0F3F6` / `#8B929B` / `#626A75` | 对比 11.8 / 6.1 / 3.5 |
| accent / hover / contrast | `#8C9EFF` / `#B0BEFF` / `#0A0C10` | 对比 7.7 |
| user-bg / border | `#1B2130` / `#2E3852` | 用户引用块底 |
| code-bg / header | `#0A0C0F` / `#13161A` | 代码 |

### 3.3 雾蓝 Haze（Glacier）

| Token | 值 | 用途 |
| --- | --- | --- |
| bg | `#172631` | 画布（带蓝） |
| bg-panel | `#1D2F3B` | 侧栏 |
| bg-elevated | `#233845` | 弹层 / 抬升面 |
| bg-hover / selected | `#263D4B` / `#2C4757` | 交互态 |
| border / subtle | `#334E5E` / `#223945` | 发丝（带蓝） |
| text / strong / muted / dim | `#D3E6F2` / `#EEF8FF` / `#9CB8C9` / `#7391A3` | 对比 12.05 / 7.45 / 4.64 |
| accent / hover / contrast | `#6FD7FF` / `#A5E9FF` / `#06222C` | 对比 9.45；反色 10.09 |
| user-bg / border | `#1B3243` / `#2F5568` | 用户引用块底（对比 10.34） |
| code-bg / header | `#101E28` / `#162733` | 代码 |
| success / danger / warning / info | `#74DCB4` / `#FF9FA8` / `#F0C97A` / `#8ECBFF` | 语义 |

### 3.4 语法高亮（随主题）

| Token | Frost | Graphite | Haze |
| --- | --- | --- | --- |
| 关键字 | `#3450B8` | `#93A8FF` | `#9CCFFF` |
| 函数 | `#2B62B8` | `#9FD0FF` | `#A9E4FF` |
| 字符串 | `#1F7A50` | `#7EE0B0` | `#82E4C0` |
| 数字/常量 | `#6B4FC0` | `#B9A7FF` | `#C0B4FF` |
| 注释 | `#7A8A9C` | `#5F7FA6` | `#6C8FA6` |
| 标点/运算符 | `#57678A` | `#8FA3BF` | `#8EAFC4` |
| 非法/删除 | `#B3352E` | `#FF9D9D` | `#FF9FA8` |

规则：代码底色必须比所在表面**低一档**（Frost 更不能纯白），行号 dim，选区 accent 18%。

---

## 4. 字体与排版

### 4.1 字族

| 角色 | 字族 | 理由 |
| --- | --- | --- |
| UI / 标题 | **Instrument Sans** 400/500/600 | 技术感 grotesque，窄字宽适合桌面密集信息 |
| 会话正文 | **Instrument Serif** 400（可斜体） | 唯一"唯美"来源；与 UI 形成清晰对比 |
| 元数据 / 代码 | **Noto Sans Mono** 400/500 | 时间、token、工具名统一等宽对齐 |
| 中文回退 | UI：`PingFang SC` → `Microsoft YaHei`；衬线：`Songti SC` → `Noto Serif SC` → `Source Han Serif SC` | Instrument 无 CJK，必须显式声明衬线回退，否则中文正文会掉回黑体 |

### 4.2 比例（px / 行高）

| 级别 | 字号 | 行高 | 字距 | 用途 |
| --- | --- | --- | --- | --- |
| display | clamp 36–54 | 1.02 | -0.02em | 仅空状态项目名 |
| h1 | 22 | 1.25 | -0.015em | 弹窗/配置页标题 |
| ui-strong | 15 | 1.4 | -0.01em | 侧栏标题、按钮强调 |
| ui | 13.5 | 1.5 | 0 | 全局基准（body） |
| prose | 16.5 | **1.62** | 0.002em | 助手 Markdown 正文，衬线 |
| caption | 12 | 1.45 | 0 | 次要说明 |
| tag | 11 | 1.4 | 0.02em | 工具名、标签（等宽） |
| meta | 10 | 1.35 | 0.04em | 角色行、时间、路径（等宽） |

- 正文测宽：助手 prose `70ch`；transcript 容器 `860px`；空状态 `720px`。
- **禁止**全大写英文标签；角色标签保持小写（`you` / `assistant`），中文用"你/助手"。
- 数字（token、耗时、费用）一律 `tabular-nums`。

---

## 5. 间距 / 圆角 / 描边 / 阴影

### 5.1 间距（4px 网格）

`2 · 4 · 6 · 8 · 10 · 12 · 16 · 20 · 24 · 32 · 40 · 56 · 72`

| 位置 | 值 |
| --- | --- |
| 侧栏内边距 / 行内边距 | 10 / 6×8 |
| transcript 左右留白 | 26（窄窗 16） |
| 对话轮次上下 | 16 / 20 |
| 工具行 | 5×9；展开区 8×10 |
| 输入区 | 上下 12，左右 14；按钮 28×28 |
| 弹窗 | 20；标题到内容 14 |

### 5.2 圆角

| Token | 值 | 用途 |
| --- | --- | --- |
| r-tag | 2 | 状态 chip、行内标签 |
| r-control | **4** | 按钮、输入、下拉、行 |
| r-panel | **6** | 工具卡、代码块、思考块 |
| r-overlay | **10** | 弹窗、浮层 |
| r-pill | 999 | **仅**状态圆点/计数，不用于按钮 |

> 当前 3/5 → 4/6/10：保留"硬朗"，但让面板有可读的转角，避免报纸感。

### 5.3 描边

- 唯一描边宽度：1px；分隔线用 `border-subtle`，结构边界用 `border`。
- 强调线：用户消息左侧 **2px accent**；选中行左侧 **2px inset accent**。
- 不做双色边框、不做发光边框。

### 5.4 阴影（只有两层）

| 层级 | 规则 |
| --- | --- |
| 0 平面 | 无阴影；靠底色 + 1px 描边区分 |
| 1 浮层 | 1px 描边 + 柔和冷色投影（Frost `rgba(21,43,74,.16)`，Dark/Haze `rgba(0,0,0,.55)`，模糊 32–40，y 16–20） |

- **禁止**背景模糊（backdrop-filter）、禁止卡片投影、禁止渐变按钮。
- Glacier 的抬升面额外加"霜边"1px 内高光。

---

## 6. 动效

| 场景 | 时长 | 曲线 |
| --- | --- | --- |
| hover / 颜色 | 150ms | smooth-out |
| 展开 / 折叠 | 250ms | smooth-out |
| 主题切换 | 400ms | 圆形擦除（已有） |
| 空状态入场 | 600ms，仅一次 | 透明度 + 4px 上移 |

- 只有**一个**编排时刻：进入新会话时，空状态文字与发光体一次淡入；其余一律不做"逐卡片上浮"。
- `prefers-reduced-motion` 时全部降为即时。
- 流式输出的光标/思考球是功能动效，保留。

---

## 7. 组件规范（要点）

**侧栏**：244px；三区（项目、会话、文件）；会话行 28px 高；选中态 = 2px inset accent + `text-strong`；时间戳等宽 10px dim；不做整块高亮底（避免色块打架）。

**标签栏**：36px；活动标签用 2px accent 下划线，不用胶囊；关闭按钮 hover 才显形。

**对话流**：角色行（等宽 10px `you`/`assistant` + 时间）→ 正文 → 操作行（hover 显形）。轮次之间 1px `border-subtle` 分隔，首轮无分隔。

**用户消息**：保留"引文块"签名——左侧 2px accent、`text-strong`、无气泡、无底色；多行时上下内边距 1px，长文自然撑开。

**助手消息**：衬线 16.5/1.62，`text` 色；标题仍用无衬线（结构信息），代码/表格/行内码切等宽 12.5。

**工具行**：单行 = 工具名（等宽 11，accent）+ 参数预览（等宽 11，muted，单行省略）+ 耗时（等宽 10，dim）+ 折叠箭头。展开后参数区 `code-bg`，结果区用比参数区更亮一档；错误行仅换边框与文字色，不加红色底。

**思考块**：单行折叠（`thinking` 标签 + 耗时），展开为等宽 11 正文；边框用 `border-subtle`，不抢工具行的层级。

**代码块**：语言标签（等宽 10 dim）+ 复制（hover 才显形，hover 变 accent）；1px 边框、6px 圆角、内部 12px 留白；不使用头部底色渐变。

**输入区**：整条 band 顶部 1px 分隔 + 画布同色；输入壳最大 820px 居中，1px 描边、4px 圆角、聚焦时 accent 描边 + 2px 外环；发送键 28px 方形 accent；**无投影**。

**空状态**：`kicker（新会话，等宽 10）` → 项目名（衬线 display）→ 路径（等宽 11）→ 输入区。左侧或后方放置**唯一发光体**（BrandLogo 或思考球），不铺卡片。

**弹窗**：10px 圆角；遮罩 `rgba(6,14,22,0.55)`（**无模糊**）；标题无衬线 15/600；内容滚动区独立，底部操作右对齐。

**状态与 toast**：2px 圆角 chip + 5px 状态点；只允许 success/danger/warning/info 四色，且必须同时有文字，不单靠颜色。

**文件查看器**：与消息内代码块同一语法表；行号 dim、当前行用 `bg-subtle`；工具条与标签栏同高。

---

## 8. 可访问性底线

- 正文对比 ≥ 7:1；次要文字 ≥ 4.5:1（上表所有 `text-muted` 已达标；`text-dim` 仅用于非关键元数据，不低于 3:1）。
- 键盘焦点：2px accent 外环 + 1px 偏移，任何交互元素都可见。
- 不用颜色单独表意（错误同时有图标/文案）。
- 减小动效遵循系统设置。
- 中文/英文混排不依赖字体粗细区分层级（Instrument Sans 中文会回退，用字号和颜色承担层级）。

---

## 9. 实施顺序（确认后执行）

| 阶段 | 内容 |
| --- | --- |
| P0 | 修复 `MessageView.tsx:662` 未定义 `isError`（阻塞一切视觉验收） |
| P1 | 三套 token 落地 + 标题栏/启动页/错误页同步（`electron/title-bar-overlay.ts`、`startup.html`、`global-error.tsx`） |
| P2 | 对话流：角色行、用户引文块、助手衬线、工具/思考/代码块 |
| P3 | chrome：侧栏选中态、标签栏、输入区 band、空状态发光体 |
| P4 | 弹窗与配置页；清理 30+ 处硬编码色（`SkillsConfig`、`models-config/*`、`ExtensionUiDialog`） |
| P5 | 截图验收矩阵：3 主题 × 5 页面（新会话 / 长会话 / 文件查看器 / 设置 / 错误页） |

验收口令：把 Dark 与 Glacier 并排放在同一张图里，**非设计同事能一眼指出哪个是蓝色主题**，且三套主题的正文行宽、字号、间距完全一致。

---

## 10. 需要你拍板的 4 件事

1. **Glacier 方向**：推荐"雾蓝 Haze"（`#172631` + `#6FD7FF`）；是否接受更浓的"冰川蓝"备选（`#0B2A3D` + `#64E0FF`）？
2. **中文衬线回退**：接受 `Songti SC / Noto Serif SC` 作为助手正文的中文字体（不额外加载 webfont）？
3. **空状态锚点**：恢复发光的 BrandLogo，还是只用思考球？二选一，避免两个发光体。
4. **圆角放宽**：工具/代码块 3 → 6，弹窗 5 → 10，是否可接受？

## 11. 落地记录

| 阶段 | 结果 |
| --- | --- |
| P0 | ✅ `MessageView.tsx` 的 `data-error={isError}` 已移除（thinking 块无错误态），`tsc --noEmit` 0 error |
| P1 | ✅ 三套 token 落地：`app/globals.css`（Frost/Graphite/Haze + `--scrim`、`--accent-soft`、`--radius-{tag,control,panel,overlay}`、Glacier 雾面 wash + 霜边投影）；`electron/title-bar-overlay.ts`（含测试）、`electron/startup.html`、`app/global-error.tsx` 同步 |
| P2 | ✅ `piforgeLightSyntaxTheme` / `piforgeDarkSyntaxTheme` / `piforgeGlacierSyntaxTheme` + `syntaxThemeFor(theme)`，`FileViewer`/`MessageView` 按 `theme` 取用 |
| P3 | ✅ 空状态发光体（`.ledger-empty::before`，600ms 一次性入场，reduced-motion 关闭）；侧栏选中态改为 2px inset accent，不铺色块；工具/思考/代码块统一 `--radius-panel` |
| P4 | ✅ 弹窗遮罩统一 `--scrim`，浮层统一 `--shadow-popover`，成功/失败色统一 `--success*`/`--danger*`，`rgba(99,102,241,*)` 等旧强调色清零 |
| P5 | ⏳ 3 主题截图见 `tmp/shots/v2-*.webp` |

**仍待拍板**：§10 第 3 项（空状态用 BrandLogo 还是思考球）——当前实现是主题色光晕，
`components/BrandLogo.tsx` 仍未挂载；`components/models-config/ThinkingLevelMapEditor.tsx`
的 6 个思考等级色属于数据级配色，未纳入 token。
