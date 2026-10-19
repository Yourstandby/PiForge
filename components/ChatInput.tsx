"use client";

/* Props/ref are unused on purpose while the shell stays empty. */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { forwardRef } from "react";
import type { ChatInputHandle } from "./chat-input/types";

export type { ChatInputHandle };

/**
 * Placeholder shell. The real composer now lives in `components/Composer.tsx`.
 */
export const ChatInput = forwardRef<ChatInputHandle, Record<string, unknown>>(
  function ChatInput(_props, _ref) {
    return <div />;
  },
);

export default ChatInput;
