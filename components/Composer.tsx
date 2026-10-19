"use client";

import { useCallback, useEffect, useRef } from "react";
import { ArrowUp } from "lucide-react";

const MAX_HEIGHT = 200;

export function Composer({
  value = "",
  onValueChange,
  onSubmit,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit?: (value: string) => void;
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

  const canSend = value.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSubmit?.(value.trim());
    onValueChange("");
    textareaRef.current?.focus();
  };

  return (
    <div className="w-full rounded-2xl border border-neutral-200 bg-white p-2.5 shadow-sm transition-shadow duration-200 focus-within:border-neutral-300 focus-within:shadow-md">
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
        className="block w-full resize-none bg-transparent px-2 pt-1.5 text-[15px] leading-6 text-neutral-900 placeholder:text-neutral-400 outline-none"
      />
      <div className="mt-1 flex items-center justify-between px-1">
        <span className="text-[11px] text-neutral-400">
          Enter 发送 · Shift + Enter 换行
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="发送"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-900 text-white transition-colors duration-150 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
        >
          <ArrowUp size={15} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

export default Composer;
