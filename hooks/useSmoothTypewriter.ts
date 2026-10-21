"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type MessageLike = { content?: unknown };

/** 统计一条消息里所有 text block 的总字符数（思考/工具块不参与打字机）。 */
function countTextChars(message: MessageLike | null): number {
  if (!message) return 0;
  const content = message.content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    const typed = block as { type?: string; text?: string };
    if (typed?.type === "text" && typeof typed.text === "string") total += typed.text.length;
  }
  return total;
}

/** 只截断 text block，保留 thinking / tool / image 等结构（否则工具卡会闪掉）。 */
function truncateText<T extends MessageLike>(message: T, budget: number): T {
  const content = (message as MessageLike).content;
  if (typeof content === "string") {
    return { ...(message as object), content: content.slice(0, budget) } as T;
  }
  if (!Array.isArray(content)) return message;
  let left = Math.max(0, budget);
  const next = content.map((block) => {
    const typed = block as { type?: string; text?: string };
    if (typed?.type !== "text" || typeof typed.text !== "string") return block;
    if (left <= 0) return { ...typed, text: "" };
    const slice = typed.text.slice(0, left);
    left -= slice.length;
    return { ...typed, text: slice };
  });
  return { ...(message as object), content: next } as T;
}

/**
 * 平滑打字机缓冲层。
 *
 * 上游 provider 的 `message_update` 粒度可能非常大（一次几百字），直接渲染就是
 * "啪一下全出来"。这个 hook 把目标文本当成水位线，用 requestAnimationFrame
 * 每帧只放 `charsPerFrame` 个字符出来，视觉上就是连续打字；`enabled` 变 false
 * （流式结束 / 收到 finish）时立即追平，不会让用户等着看完。
 *
 * 实现要点：状态只存"已揭示字符数"，目标字符数和 rAF 句柄放 ref，
 * 因此每帧只触发一次极小范围的 setState，不会有额外的数组拷贝。
 */
export function useSmoothTypewriter<T extends MessageLike | null>(
  message: T,
  enabled: boolean,
  /** 最小每帧字数（默认 20）；实际步长按积压量指数增长。 */
  minCharsPerFrame = 30,
): { message: T; typing: boolean } {
  const total = useMemo(() => countTextChars(message), [message]);
  const totalRef = useRef(total);
  totalRef.current = total;

  const [revealed, setRevealed] = useState(0);
  const revealedRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  /**
   * 指数级加速度打字机（每帧必提交）：
   *   step = max(20, ceil(behind * 0.25))
   * - 积压 1000 字 → 一帧吐 250，四帧左右飙完；
   * - 积压 200 字  → 一帧吐 50；
   * - 积压 < 100   → 直接一次性铺满并停掉 rAF（不再磨叽）。
   * 视觉上"文字铺满"和底层 token 结算基本同步，不会割裂。
   */
  const pendingRef = useRef(0);
  const frameRef = useRef(0);
  const tick = useCallback(() => {
    rafRef.current = null;
    const goal = totalRef.current;
    const behind = goal - revealedRef.current;
    if (behind <= 0) return; // 追平 → 暂停，等下一个 chunk

    if (behind < 100) {
      // 尾巴直接定格，不再逐帧挤
      revealedRef.current = goal;
      pendingRef.current = 0;
      setRevealed(goal);
      return;
    }

    // 每帧累积 30 字，但每 2 帧才提交一次 → 30fps × 30 字 ≈ 900 字/秒
    const step = Math.max(minCharsPerFrame, Math.ceil(behind * 0.25));
    pendingRef.current = Math.min(goal, revealedRef.current + pendingRef.current + step);
    frameRef.current += 1;
    if (frameRef.current % 2 === 0 || pendingRef.current >= goal) {
      revealedRef.current = pendingRef.current;
      pendingRef.current = 0;
      setRevealed(revealedRef.current);
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [minCharsPerFrame]);

  useEffect(() => {
    if (!enabled) {
      // 结束 / 非流式：瞬间补齐剩余字符
      stop();
      if (revealedRef.current !== totalRef.current) {
        revealedRef.current = totalRef.current;
        setRevealed(totalRef.current);
      }
      return;
    }
    // 换了一条新消息（文本变短）→ 重新从头打
    if (totalRef.current < revealedRef.current) {
      revealedRef.current = 0;
      setRevealed(0);
      return;
    }
    if (revealedRef.current < totalRef.current && rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [enabled, total, tick, stop]);

  useEffect(() => stop, [stop]);

  const display = useMemo(
    () => (message ? truncateText(message, enabled ? revealed : total) : message),
    [message, revealed, enabled, total],
  );

  return { message: display, typing: enabled && revealed < total };
}

/**
 * 简易字符串打字机：用于工具卡片在执行中的"参数摘要 / 日志"逐字刷出。
 * 目标文本增长时继续吐字；文本被替换（长度回退）时从头开始；禁用时立即补齐。
 */
export function useTypedText(target: string, enabled: boolean, charsPerFrame = 12): string {
  const [revealed, setRevealed] = useState(0);
  const revealedRef = useRef(0);
  const targetRef = useRef(target);
  targetRef.current = target;
  const rafRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    rafRef.current = null;
    const goal = targetRef.current.length;
    const behind = goal - revealedRef.current;
    if (behind <= 0) return;
    const step = behind > 400 ? Math.max(charsPerFrame, Math.ceil(behind / 8)) : charsPerFrame;
    revealedRef.current = Math.min(goal, revealedRef.current + step);
    setRevealed(revealedRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [charsPerFrame]);

  useEffect(() => {
    if (!enabled) {
      stop();
      if (revealedRef.current !== targetRef.current.length) {
        revealedRef.current = targetRef.current.length;
        setRevealed(revealedRef.current);
      }
      return;
    }
    if (revealedRef.current > targetRef.current.length) {
      revealedRef.current = 0;
      setRevealed(0);
      return;
    }
    if (revealedRef.current < targetRef.current.length && rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [enabled, target, tick, stop]);

  useEffect(() => stop, [stop]);

  return target.slice(0, enabled ? revealed : target.length);
}
