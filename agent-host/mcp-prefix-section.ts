/**
 * `mcp_servers` 段的字节稳定层 —— 前缀缓存（prompt caching）的根治点之一。
 *
 * 背景（真实现象，来自 session 记录）：
 *   第 1 轮  `- mcp__fast_anything (codemode)`
 *   连上后   `- mcp__fast_anything (codemode): fast-anything speeds up Python, …`
 *
 * 差异只来自 `renderServersSection()` 的 `serverSummary()`：
 *   配置里有 description 就用它（静态），否则退回 `connection.instructions`（**连上才有**）。
 * 而暴露成 codemode / deferred 的间接服务器，第一轮**不等待连接**
 * （`waitForDirectServers()` 只等直连服务器），于是这一段的字节必然在会话早期变一次；
 * 之后再遇重连 / 配置重载还会继续抖。`sections.mcp_servers` 一抖，整段历史按未命中重发。
 *
 * 这里不改 MCP 扩展的加载与发现路径（工具仍按需连接、经 codemode / tool_search 发现），
 * 只按「服务器名 + 暴露方式」给这段内容做签名与锁存：
 * 签名不变 → 沿用第一次看到的字节；签名变了（用户真的增删 / 开关了服务器）才重新取一次。
 */

export const MCP_SERVERS_SECTION = "mcp_servers";

/** `- mcp__name (codemode)` 或 `- mcp__name (tool_search): 描述` */
const SERVER_LINE = /^-\s+(\S+)\s+\(([^)]*)\)(?:\s*:.*)?$/;

/**
 * 段的**结构签名**：只保留服务器名与暴露方式，丢弃描述（描述是易变的那一半）。
 * 同名同暴露方式的任意两次渲染签名相同 → 可以安全复用旧字节。
 */
export function mcpSectionSignature(section: string): string {
  const servers: string[] = [];
  for (const rawLine of section.split("\n")) {
    const match = SERVER_LINE.exec(rawLine.trim());
    if (match) servers.push(`${match[1]}(${match[2]})`);
  }
  return servers.join(",");
}

/** 锁存状态：签名 + 首次看到的字节。 */
export interface McpSectionLatch {
  signature: string;
  section: string;
}

/**
 * 把「本轮渲染出来的段」收敛成「可以发出去的段」：
 *   - 空 / undefined → 原样返回（段消失是配置变化，交给调用方处理）；
 *   - 签名与锁存一致 → 返回锁存字节（描述有无都不再影响前缀）；
 *   - 签名变了 → 重新锁存这一版，返回新字节（用户显式改配置，允许一次失效）。
 *
 * 纯函数 + 显式状态：同样的输入序列永远同样的输出，便于单测。
 */
export function stabilizeMcpSection(
  section: string | undefined,
  latch: McpSectionLatch | null
): { section: string | undefined; latch: McpSectionLatch | null } {
  if (section === undefined || section.length === 0) return { section, latch };
  const signature = mcpSectionSignature(section);
  if (latch && latch.signature === signature) return { section: latch.section, latch };
  return { section, latch: { signature, section } };
}
