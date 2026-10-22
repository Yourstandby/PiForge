/**
 * 会话作用域资源登记（第二部分 · 彻底清理）。
 *
 * 现象：切了几个会话之后，滚动变卡、内存一路涨 —— 上一个会话留下的
 * `setInterval`（运行 / 结束对账）、`ResizeObserver`（贴底滚动）、
 * 延迟 `setTimeout`（自动标题、乐观刷新）还在跑，回调里读到的却是已经
 * 卸载的那份状态。
 *
 * 规则：**凡是挂在某个会话上的定时器/观察者，都必须登记到会话作用域**。
 * 切换会话（或关闭标签）时一次性 `disposeSession(previousId)`，
 * 保证「旧会话再也不会回调」。
 */

type Disposer = () => void;

export class SessionScope {
  private readonly bySession = new Map<string, Set<Disposer>>();

  /** 登记一个释放函数；返回幂等的取消登记函数。 */
  track(sessionId: string | null | undefined, dispose: Disposer): Disposer {
    const key = sessionId ?? "__global__";
    let set = this.bySession.get(key);
    if (!set) {
      set = new Set();
      this.bySession.set(key, set);
    }
    set.add(dispose);
    return () => {
      set?.delete(dispose);
    };
  }

  /** 注册定时器（到时自动取消登记）。 */
  setTimeout(sessionId: string | null | undefined, run: () => void, ms: number): () => void {
    const timer = setTimeout(() => {
      untrack();
      run();
    }, ms);
    const untrack = this.track(sessionId, () => clearTimeout(timer));
    return untrack;
  }

  /** 注册周期任务（会话切换时自动清掉）。 */
  setInterval(sessionId: string | null | undefined, run: () => void, ms: number): () => void {
    const timer = setInterval(run, ms);
    return this.track(sessionId, () => clearInterval(timer));
  }

  /** React 组件里的「会话切换即销毁」。 */
  onSessionSwitch(previousId: string | null | undefined): void {
    if (!previousId) return;
    this.disposeSession(previousId);
  }

  disposeSession(sessionId: string): void {
    const set = this.bySession.get(sessionId);
    if (!set) return;
    this.bySession.delete(sessionId);
    for (const dispose of set) {
      try {
        dispose();
      } catch {
        /* 清理失败不能阻断切换 */
      }
    }
  }

  disposeAll(): void {
    for (const sessionId of [...this.bySession.keys()]) this.disposeSession(sessionId);
  }

  /** 测试用：当前登记数。 */
  size(): number {
    let total = 0;
    for (const set of this.bySession.values()) total += set.size;
    return total;
  }
}

/** 进程内单例（HMR 安全）。 */
const store = globalThis as typeof globalThis & { __piforgeSessionScope?: SessionScope };
if (!store.__piforgeSessionScope) store.__piforgeSessionScope = new SessionScope();
export const sessionScope: SessionScope = store.__piforgeSessionScope;
