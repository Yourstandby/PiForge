"use client";

import { useCallback, useEffect, useRef } from "react";
import { ArrowUp, Square } from "lucide-react";

const MAX_HEIGHT = 200;

export function Composer({
  value = "",
  onValueChange,
  onSubmit,
  onStop,
  busy = false,
  disabled = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  const canSend = value.trim().length > 0 && !disabled;

  const submit = () => {
    if (!canSend || busy) return;
    onSubmit?.(value.trim());
    onValueChange("");
    textareaRef.current?.focus();
  };

  return (
    <div className="w-full rounded-2xl border border-[#E4E4E0] bg-white p-2.5 shadow-sm transition-all duration-200 focus-within:border-[#BFD4FD] focus-within:shadow-md">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder="问点什么，或者描述你想构建的东西…"
        aria-label="输入消息"
        className="block w-full resize-none bg-transparent px-2 pt-1.5 text-[15px] leading-6 text-ink caret-accent outline-none placeholder:text-ink-faint"
      />
      <div className="mt-1 flex items-center justify-between px-1">
        <span className="text-[11px] text-ink-faint">
          Enter 发送 · Shift + Enter 换行
        </span>
        {busy && onStop ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="停止生成"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white transition-colors duration-150 hover:bg-accent-strong"
          >
            <Square size={10} strokeWidth={0} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="发送"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white transition-colors duration-150 hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-[#E9E9E5] disabled:text-ink-faint"
          >
            <ArrowUp size={15} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}

export default Composer;
