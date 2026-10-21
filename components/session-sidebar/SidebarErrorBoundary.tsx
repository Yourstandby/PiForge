"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 侧边栏局部错误边界。
 *
 * 只要「项目列表里某一行」在渲染/事件里抛错，整棵 SessionSidebar 就会被卸载，
 * 表现为左侧栏整块白屏。这里把崩溃限制在列表内部：仍保留头部（搜索 / ＋）
 * 与一个可重试的提示，绝不带走整个侧边栏。
 */
export class SidebarErrorBoundary extends Component<
  { children: ReactNode; onRetry?: () => void },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Sidebar project list crashed", error, info.componentStack);
  }

  private reset = () => {
    this.setState({ hasError: false });
    this.props.onRetry?.();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="sidebar-empty" role="alert">
        <p>项目列表渲染失败。</p>
        <button
          type="button"
          onClick={this.reset}
          className="mt-1 rounded-md border border-border px-2 py-1 text-[11px] text-ink-muted transition-colors hover:bg-[#ECECEF] hover:text-ink"
        >
          重试
        </button>
      </div>
    );
  }
}

export default SidebarErrorBoundary;
