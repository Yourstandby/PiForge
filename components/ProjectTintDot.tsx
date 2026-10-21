"use client";

import { projectTintStyle } from "@/lib/project-color";

/**
 * 项目微胶囊：8×8 圆角小方块，半透明填充 + 同色系描边。
 * 顶部标签与左侧项目列表共用同一个组件，保证尺寸/形状完全一致。
 */
export function ProjectTintDot({
  cwd,
  size = 8,
  className = "",
}: {
  cwd: string | null | undefined;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-[3px] ${className}`}
      style={{ width: size, height: size, ...projectTintStyle(cwd) }}
    />
  );
}

export default ProjectTintDot;
