"use client";

import { X } from "lucide-react";
import { FileViewer } from "./FileViewer";

export function FileViewerPanel({
  filePath,
  cwd,
  onClose,
}: {
  filePath: string;
  cwd: string | null;
  onClose: () => void;
}) {
  const name = filePath.split(/[\/]/).pop() ?? filePath;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-[#FCFCFA]">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-[#EBEDF1] px-4">
        <div className="min-w-0 truncate text-[12px] text-ink-muted" title={filePath}>
          <span className="text-ink-faint">文件 · </span>
          {name}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭文件"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-150 hover:bg-[#ECECEF] hover:text-ink"
        >
          <X size={15} strokeWidth={1.75} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <FileViewer filePath={filePath} cwd={cwd ?? undefined} />
      </div>
    </div>
  );
}

export default FileViewerPanel;
