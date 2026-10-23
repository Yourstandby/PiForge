"use client";

import { useMemo } from "react";
import { toolTone } from "./tool-tone";

type RunningTool = { id?: string; name: string };

/**
 * 「正在跑什么」的唯一一处渲染（输入框上方，和「本轮产出」那条并排）。
 *
 * 数据源是 `useAgentSession().agentPhase`（由 pi 的 `tool_execution_start/end`
 * 按 toolCallId 增删），所以 read/write 这种**毫秒级**工具也会如实出现，不依赖
 * 工具卡是否还在流式、也不依赖"模型是否已开始写最终回复"。
 *
 * 布局：**一个工具一个徽章**，横着并排铺一行，不做 `read, write, bash` 那种
 * 合并文案——每个工具自己的颜色才看得出来"现在同时在跑几个"。
 */
export function RunningToolsBadge({
  tools,
  className = "",
  max = 3,
}: {
  tools?: RunningTool[] | null;
  /** 位置相关的布局类（间距 / shrink / 最大宽度）。 */
  className?: string;
  /** 最多并排几个徽章，其余折成 +N。 */
  max?: number;
}) {
  const names = useMemo(() => {
    const seen = new Set<string>();
    for (const tool of tools ?? []) {
      const name = tool?.name?.trim();
      if (name) seen.add(name);
    }
    return Array.from(seen);
  }, [tools]);

  if (names.length === 0) return null;

  const shown = names.slice(0, max);
  const rest = names.length - shown.length;

  return (
    <div
      className={`flex min-w-0 shrink flex-nowrap items-center gap-1 ${className}`}
      title={`正在执行：${names.join(" · ")}`}
    >
      {shown.map((name) => (
        <RunningToolChip key={name} name={name} />
      ))}      {rest > 0 && (
        <span className="shrink-0 rounded-md bg-[#F4F4F5] px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
          +{rest}
        </span>
      )}
    </div>
  );
}

function RunningToolChip({ name }: { name: string }) {
  const tone = toolTone(name);
  return (
    <div
      role="status"
      aria-label={`running: ${name}`}
      className={`flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] ${tone.badge} ${tone.text}`}
    >
      <span className="flex h-2.5 shrink-0 items-end gap-[2px]" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className={`beat-bar w-[2px] rounded-sm ${tone.bar}`}
            style={{ height: "10px", animationDelay: `${index * 0.15}s` }}
          />
        ))}
      </span>
      <span className="min-w-0 max-w-[160px] flex-1 truncate font-mono">running: {name}</span>
    </div>
  );
}

export default RunningToolsBadge;
