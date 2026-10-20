"use client";

import type { DiffLine } from "@/lib/diff-lines";

/**
 * Shared diff row renderer: old/new line-number gutters plus green/red rows.
 * Used by the Git panel and by `edit`/`write` tool cards in the transcript, so
 * both surfaces read identically. Fed by lib/diff-lines.ts only.
 */
export function DiffRow({ row }: { row: DiffLine }) {
  const tone =
    row.kind === "add"
      ? "bg-[#EAF6EE] text-[#22603D]"
      : row.kind === "del"
        ? "bg-[#FBEDEC] text-[#A03A32]"
        : row.kind === "hunk"
          ? "bg-[#F0F5FD] text-[#3B6DB5]"
          : row.kind === "meta"
            ? "text-ink-faint"
            : "text-[#374151]";

  if (row.kind === "hunk" || row.kind === "meta") {
    return (
      <div className={`flex font-mono text-[11px] leading-[1.6] ${tone}`}>
        <span className="w-[34px] shrink-0" aria-hidden="true" />
        <span className="w-[34px] shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all px-2">{row.text || " "}</span>
      </div>
    );
  }

  return (
    <div className={`flex font-mono text-[11px] leading-[1.6] ${tone}`}>
      <span className="w-[34px] shrink-0 select-none border-r border-black/[0.04] pr-1 text-right text-[10px] text-ink-faint">
        {row.oldLine ?? ""}
      </span>
      <span className="w-[34px] shrink-0 select-none border-r border-black/[0.04] pr-1 text-right text-[10px] text-ink-faint">
        {row.newLine ?? ""}
      </span>
      <span className={`min-w-0 flex-1 whitespace-pre-wrap break-all px-2 ${row.kind === "add" ? "bg-[#EAF6EE]" : row.kind === "del" ? "bg-[#FBEDEC]" : ""}`}>
        {row.text || " "}
      </span>
    </div>
  );
}

export function DiffRows({ rows, className = "" }: { rows: DiffLine[]; className?: string }) {
  return (
    <div className={`font-mono ${className}`}>
      {rows.map((row, index) => (
        <DiffRow key={index} row={row} />
      ))}
    </div>
  );
}

export default DiffRows;
