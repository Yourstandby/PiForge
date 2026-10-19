"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentMessage } from "@/lib/types";

const markdownComponents: Components = {
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mb-3 mt-5 text-[17px] font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2.5 mt-5 text-[15.5px] font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-4 text-[14.5px] font-semibold first:mt-0">{children}</h3>,
  ul: ({ children }) => <ul className="mb-3 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="mb-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-[#DCE6F8] pl-3 text-ink-muted">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent-strong underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-lg border border-[#E3E8F2] bg-[#F5F8FD] p-3 text-[12.5px] leading-6">
      {children}
    </pre>
  ),
  code: ({ className, children }) =>
    className ? (
      <code className="font-mono text-[12.5px]">{children}</code>
    ) : (
      <code className="rounded bg-[#EDF3FD] px-1 py-0.5 font-mono text-[0.9em] text-ink">{children}</code>
    ),
  hr: () => <hr className="my-5 border-[#E3E8F2]" />,
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-[#E3E8F2] px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-[#E3E8F2] px-2 py-1">{children}</td>,
};

function userText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function assistantParts(message: AgentMessage): { text: string; tools: string[] } {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return { text: "", tools: [] };

  const text: string[] = [];
  const tools: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
    } else if (block.type === "toolCall") {
      const name = (block.toolName ?? block.name) as string | undefined;
      if (name && !tools.includes(name)) tools.push(name);
    }
  }
  return { text: text.join("\n\n"), tools };
}

export function Transcript({ messages }: { messages: AgentMessage[] }) {
  const turns = messages
    .map((message) => {
      if (message.role === "user") {
        const text = userText(message).trim();
        return text ? { role: "user" as const, text, tools: [] as string[] } : null;
      }
      if (message.role === "assistant") {
        const { text, tools } = assistantParts(message);
        return text.trim() ? { role: "assistant" as const, text, tools } : null;
      }
      if (message.role === "custom") {
        const text = userText(message).trim();
        return text ? { role: "assistant" as const, text, tools: [] as string[] } : null;
      }
      return null;
    })
    .filter((turn): turn is { role: "user" | "assistant"; text: string; tools: string[] } => turn !== null);

  if (turns.length === 0) {
    return <p className="py-10 text-center text-[13px] text-ink-faint">这段会话还没有可显示的对话</p>;
  }

  return (
    <div>
      {turns.map((turn, index) => (
        <article key={index} className="mb-8 last:mb-0">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint">
            {turn.role === "user" ? "你" : "PiForge"}
          </div>
          {turn.role === "user" ? (
            <div className="whitespace-pre-wrap break-words rounded-xl border border-[#E7E9EE] bg-white px-4 py-3 text-[14px] leading-7 text-ink shadow-[0_1px_2px_rgba(17,17,17,0.03)]">
              {turn.text}
            </div>
          ) : (
            <div className="break-words text-[14px] leading-7 text-ink-soft">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {turn.text}
              </ReactMarkdown>
            </div>
          )}
          {turn.tools.length > 0 && (
            <div className="mt-2 text-[11px] text-ink-faint">
              工具 · {turn.tools.join(" · ")}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

export default Transcript;
