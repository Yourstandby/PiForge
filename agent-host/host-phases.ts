/**
 * Host 冷启动阶段打点（零依赖，只用于回答"这 3 秒花在哪儿"）。
 *
 * 输出格式固定为 `[agent-host] [phase] <name> ms=<距进程启动> delta=<距上一阶段>`：
 *   - `ms` 用 `process.uptime()` 反推，**包含** Node/V8 启动与 ESM 模块图求值；
 *   - `delta` 是两阶段之间的净耗时，直接对应优化项。
 *
 * 为什么不能用 `performance.now()`：它和进程启动同一时基，但拿不到"启动前"的部分，
 * `process.uptime()` 才能把 Electron utilityProcess 的进程创建也算进来。
 *
 * 常量极小、无 import：放进入口模块不会污染被测量的模块图。
 */
import process from "node:process";

let lastMs = Math.round(process.uptime() * 1000);

/** 本模块求值时刻（≈ Node/V8 启动 + 入口模块自身解析的耗时）。 */
export const hostModuleLoadMs = lastMs;

export function hostPhase(name: string, detail?: string): void {
  const nowMs = Math.round(process.uptime() * 1000);
  const delta = nowMs - lastMs;
  lastMs = nowMs;
  console.log(`[agent-host] [phase] ${name} ms=${nowMs} delta=${delta}${detail ? ` ${detail}` : ""}`);
}
