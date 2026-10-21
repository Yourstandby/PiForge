"use client";

import { X } from "lucide-react";
import { ModalSurface } from "./ModalSurface";

interface HelpSection {
  title: string;
  hint: string;
  items: Array<{ name: string; description: string }>;
}

/**
 * 「帮助」面板：把 PiForge 的核心能力用中文讲清楚。
 * 内容按「左侧栏 / 右侧面板 / 底部状态栏 / 设置」四块组织，和实际 UI 位置对应，
 * 这样用户看到不认识的图标时能直接对上号。
 */
const SECTIONS: HelpSection[] = [
  {
    title: "对话与会话",
    hint: "中间栏",
    items: [
      { name: "Agent 对话", description: "向 Pi 描述目标，它会读取文件、运行命令并逐步完成；支持 @ 引用文件、拖拽附件与图片。" },
      { name: "会话标签", description: "顶部标签可同时打开多个会话（每个会话独立运行、独立草稿）；标签过多时横向滚动。" },
      { name: "分支 / Fork", description: "从任意一条消息开启新分支，或克隆整段会话继续实验，原会话不受影响。" },
      { name: "Plan 模式", description: "只读分析并先给出计划，确认后再执行修改，适合生产环境或大改动。" },
      { name: "消息队列", description: "运行中按 Enter 立即打断并发送，Alt + Enter 加入队列稍后执行，队列可拖动排序。" },
    ],
  },
  {
    title: "右侧面板",
    hint: "文件 / Git / 浏览器 / 终端",
    items: [
      { name: "Files", description: "项目文件树，带 Git 改动标记；点文件在新标签页里查看与分屏阅读。" },
      { name: "Git", description: "查看工作区改动与 Diff，可直接跳到文件面板打开完整内容。" },
      { name: "Browser", description: "内置浏览器，Agent 可以自己打开页面、截图，共享同一个会话上下文。" },
      { name: "Processes / Terminal", description: "受管进程列表与内置终端；进程随会话生命周期管理，避免残留。" },
      { name: "Agents / Fleet", description: "子代理执行情况（spawn_agent 卡片可跳转）与多代理并行视图。" },
      { name: "Orchestrator", description: "把大任务拆分给多个代理并行推进，并汇总各自结果。" },
    ],
  },
  {
    title: "扩展与集成",
    hint: "左下角工具栏上组",
    items: [
      { name: "Plugins", description: "插件面板：查看、启用或停用扩展，插件可以注入工具、命令与 UI 视图。" },
      { name: "Agents", description: "子代理面板：查看每个子任务的输入、工具调用与产出。" },
      { name: "Skills", description: "技能库：安装 / 更新技能包，技能会被自动匹配到合适的任务。" },
      { name: "MCP", description: "MCP 服务与资源：连接外部 MCP server，浏览它提供的资源与工具。" },
    ],
  },
  {
    title: "设置与状态",
    hint: "左下角设置齿轮 / 底部状态栏",
    items: [
      { name: "Models", description: "登录与模型列表：选择当前模型、查看上下文窗口与思考强度支持情况。" },
      { name: "Auto", description: "Auto 路由：按提示复杂度在快模型与强模型之间自动选择。" },
      { name: "Aux models", description: "辅助模型：生图、标题生成、决策等轻量任务使用的小模型。" },
      { name: "Provider", description: "自定义 Provider：接入 Ollama、自建网关或兼容 OpenAI 的服务。" },
      { name: "Dev", description: "开发环境与浏览器权限：检测工具链、配置内置浏览器的访问策略。" },
      { name: "Extensions", description: "扩展与集成总览：统一管理扩展来源与连接状态。" },
      { name: "状态栏", description: "底部一行显示引擎状态、模型、权限模式、思考强度、Token / 费用 / 回合 / 工具调用；点右侧统计打开「用量与额度」。" },
    ],
  },
];

export function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <ModalSurface ariaLabelledBy="piforge-help-title">
      <div className="flex max-h-[82vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-2xl bg-white">
        <div className="flex shrink-0 items-center justify-between border-b border-[#EBEDF1] px-4 py-2">
          <div className="min-w-0">
            <span
              id="piforge-help-title"
              className="text-[11px] font-medium uppercase tracking-wider text-ink-faint"
            >
              帮助 · PiForge 功能总览
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
          >
            <X size={15} strokeWidth={1.75} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <p className="text-[12px] leading-relaxed text-ink-muted">
            PiForge 是 Pi Coding Agent 的桌面工作台：左侧管会话，中间对话，右侧看代码与运行结果。
            下面是各功能的中文速览，按它们在界面中的位置分组。
          </p>
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <div className="mb-2 flex items-baseline gap-2">
                <h3 className="text-[13px] font-semibold text-ink">{section.title}</h3>
                <span className="text-[10.5px] text-ink-faint">{section.hint}</span>
              </div>
              <div className="overflow-hidden rounded-xl border border-[#E7E9EE]">
                {section.items.map((item, index) => (
                  <div
                    key={item.name}
                    className={`flex gap-3 px-3 py-2 ${index > 0 ? "border-t border-[#EEF0F4]" : ""}`}
                  >
                    <span className="w-[92px] shrink-0 text-[12px] font-medium text-ink-soft">
                      {item.name}
                    </span>
                    <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-muted">
                      {item.description}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[#EBEDF1] px-4 py-2.5">
          <span className="text-[11px] text-ink-faint">
            提示：悬浮任何图标都会显示中文说明；状态栏右侧统计可点开「用量与额度」。
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors duration-150 hover:bg-accent-strong"
          >
            知道了
          </button>
        </div>
      </div>
    </ModalSurface>
  );
}

export default HelpModal;
