/**
 * 「这一轮还在跑 / 已经卡死」的宿主错误识别。
 *
 * 同一件事在不同层有三种文本：pi 自己的 `Session is streaming`、Host backstop
 * 抛的 `SESSION_BUSY`、以及僵尸流自愈失败时的 `SESSION_STUCK`。前两者只是
 * 「现在发不出去」，等一等会好；`SESSION_STUCK` 多一层含义 —— 宿主 abort 都
 * 掐不停，再等也不会好，必须先强制结束这一轮再发。
 */

/** 是不是「现在不能发」这一类错误（含卡死）。 */
export function isSessionBusyError(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /SESSION_BUSY|SESSION_STUCK|Session is streaming|Wait for the current response/i.test(raw);
}

/** 卡死：等下去不会自愈，只能强制结束。 */
export function isSessionStuckError(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /SESSION_STUCK/i.test(raw);
}

/**
 * 面向用户的文案：不要把英文原文和错误码直接甩到脸上。
 * 非忙类错误原样返回（压缩失败等有各自的既有话术）。
 */
export function promptErrorText(raw: string): string {
  if (isSessionStuckError(raw)) {
    return "上一轮回复卡死了（宿主强制结束失败）。点「结束并重发」会再试一次；仍失败请重启应用。";
  }
  if (isSessionBusyError(raw)) {
    return "上一轮还在跑（可能已经卡死）。点「结束并重发」会先强制结束这一轮，再发出这条消息。";
  }
  return raw;
}

/** 重试按钮文案：忙的时候不是「重试」，而是「结束并重发」。 */
export function retryActionLabel(raw: string | null | undefined): string {
  return isSessionBusyError(raw) ? "结束并重发" : "重试";
}
