/**
 * 每个工具一套色：文字色 + 徽章底色 + 跳动光条色。
 *
 * 只在这里定义一次——「输入框上方的 running 徽章」和「底部状态栏的 running 徽章」
 * 必须同色，不允许各自再发明一套（全局浅色霜蓝主题已经固定，不新增色板）。
 */
export interface ToolTone {
  /** 工具名文字色。 */
  text: string;
  /** 徽章底色（跟随「第一个」工具）。 */
  badge: string;
  /** 心跳光条色（跟随「第一个」工具）。 */
  bar: string;
}

const EDIT: ToolTone = { text: "text-[#3E8A63]", badge: "bg-[#EAF4EE]", bar: "bg-[#4E9F76]" };
const READ: ToolTone = { text: "text-[#9A6B1F]", badge: "bg-[#FBF3E4]", bar: "bg-[#B98A3C]" };
const POWERSHELL: ToolTone = { text: "text-[#C2661A]", badge: "bg-[#FDF3E8]", bar: "bg-[#D9843A]" };
const SHELL: ToolTone = { text: "text-accent-strong", badge: "bg-[#F1F7FF]", bar: "bg-accent" };
const FALLBACK: ToolTone = { text: "text-ink-muted", badge: "bg-[#F4F4F5]", bar: "bg-[#9CA3AF]" };

export function toolTone(name: string | undefined | null): ToolTone {
  const n = (name ?? "").toLowerCase();
  if (!n) return FALLBACK;
  if (n === "edit" || n === "write" || n === "apply_patch") return EDIT;
  if (n === "read") return READ;
  if (n === "powershell" || n === "pwsh") return POWERSHELL;
  if (n === "bash" || n === "terminal" || n === "cmd") return SHELL;
  return FALLBACK;
}
