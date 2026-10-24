/**
 * 多会话协作约束（**纯常量，禁止任何动态插值**）。
 *
 * 场景：同一个项目目录里同时开多个会话并行干活。共享工作区的好处是彼此能立刻
 * 看到对方的代码，坏处是「谁改的、改到哪一步」只能靠人记。这里把协作协议写成
 * 静态 bullets，注入 `systemPromptOptions.promptGuidelines`：
 *
 *   - 动手前先看 git（工作区改动 + 最近提交）＝ 读到别人的进度；
 *   - 每完成一小步就 commit ＝ 给别的会话留一条可读的记录（比 diff 便宜得多）；
 *   - `read` 结果里出现 `Note:` 署名行时，先 `git diff` 再覆盖；
 *   - 完全没有文件重叠的活交给 worktree worker，别挤在同一个 checkout 里。
 *
 * 为什么必须全是常量：prompt cache 按前缀命中，混进时间戳 / 会话 id 就会让整段
 * 前缀失效，每轮按全价重算。会话名之类的动态信息由 `desktop-file-origin`
 * 扩展在 `tool_result` 里给，不进 system prompt。
 */
export const COLLAB_GUIDELINES: readonly string[] = [
  "这个项目目录可能同时有多个 pi 会话在改。动手前先看共享状态：`git status --short` 与 `git log --oneline -5`，能看出别人已经做到哪一步。",
  "每完成一个可验证的小步就提交一次（`git add -A && git commit -m \"...\"`，信息写清改了什么、为什么）；提交历史是跨会话唯一可靠的共享记录，未提交的改动别人看不见。",
  "`read` 结果里可能带一行 `Note: ... by another session ...` 的署名：那说明该文件刚被别的会话改过。覆盖前先 `git diff -- <path>`，确认不会丢掉对方的工作。",
  "改动范围完全独立（不碰同一批文件）的活，交给 worktree worker（`orchestrator_spawn`）在独立工作树里跑；同一 checkout 里只留主线任务，减少互相覆盖。",
];
