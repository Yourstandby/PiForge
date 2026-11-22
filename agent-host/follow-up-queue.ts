export type FollowUpImage = {
  type: "image";
  data: string;
  mimeType: string;
};

export type QueuedFollowUp = {
  id: string;
  message: string;
  images?: FollowUpImage[];
  createdAt: number;
};

export type FollowUpQueueItem = {
  id: string;
  message: string;
  attachmentCount: number;
  createdAt: number;
};

export type FollowUpQueueSnapshot = {
  revision: number;
  items: FollowUpQueueItem[];
};

export class FollowUpQueue {
  private items: QueuedFollowUp[] = [];
  private revision = 0;

  snapshot(): FollowUpQueueSnapshot {
    return {
      revision: this.revision,
      items: this.items.map(({ id, message, images, createdAt }) => ({
        id,
        message,
        attachmentCount: images?.length ?? 0,
        createdAt,
      })),
    };
  }

  enqueue(item: QueuedFollowUp): FollowUpQueueSnapshot {
    this.items.push(item);
    this.revision += 1;
    return this.snapshot();
  }

  /**
   * 插到队首：人工介入指令要求「最高优先级」，不能排在用户排队消息后面。
   * 与 `enqueue` 共用 revision 语义，前端重排校验仍然有效。
   */
  prepend(item: QueuedFollowUp): FollowUpQueueSnapshot {
    this.items.unshift(item);
    this.revision += 1;
    return this.snapshot();
  }

  reorder(orderedIds: string[], expectedRevision: number): FollowUpQueueSnapshot {
    if (expectedRevision !== this.revision) {
      throw new Error("Follow-up queue changed; refresh and try again");
    }
    if (
      orderedIds.length !== this.items.length ||
      new Set(orderedIds).size !== orderedIds.length ||
      orderedIds.some((id) => !this.items.some((item) => item.id === id))
    ) {
      throw new Error("Follow-up queue order must contain every queued item exactly once");
    }

    const byId = new Map(this.items.map((item) => [item.id, item]));
    this.items = orderedIds.map((id) => byId.get(id)!);
    this.revision += 1;
    return this.snapshot();
  }

  /**
   * 删除单条排队消息。
   * 与 `reorder` 共用 revision 语义：客户端带来的 revision 过期说明队列已被别的操作改过，
   * 直接拒绝，避免删掉用户刚插进来的新消息。
   */
  remove(id: string, expectedRevision: number): FollowUpQueueSnapshot {
    if (expectedRevision !== this.revision) {
      throw new Error("Follow-up queue changed; refresh and try again");
    }
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Queued follow-up not found");
    this.items.splice(index, 1);
    this.revision += 1;
    return this.snapshot();
  }

  /**
   * 原地改写一条排队消息：id、位置、附件都不动。
   * 「删了再排」会丢附件并把顺序弄乱，编辑必须是就地改。
   */
  update(id: string, message: string, expectedRevision: number): FollowUpQueueSnapshot {
    if (expectedRevision !== this.revision) {
      throw new Error("Follow-up queue changed; refresh and try again");
    }
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Queued follow-up not found");
    const text = message.trim();
    if (!text) throw new Error("Queued follow-up message must not be empty");
    this.items[index] = { ...this.items[index], message: text };
    this.revision += 1;
    return this.snapshot();
  }

  /**
   * 取出某一条（「立即发送」用），带回它原来的下标：
   * 投递失败要按原位置放回去，不能把用户排好的队列顺序打乱。
   */
  take(
    id: string,
    expectedRevision: number,
  ): { item: QueuedFollowUp; index: number; snapshot: FollowUpQueueSnapshot } {
    if (expectedRevision !== this.revision) {
      throw new Error("Follow-up queue changed; refresh and try again");
    }
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Queued follow-up not found");
    const [item] = this.items.splice(index, 1);
    this.revision += 1;
    return { item, index, snapshot: this.snapshot() };
  }

  /** 把 `take` 取出的消息按原下标插回（越界则夹到末尾）。 */
  restoreAt(index: number, item: QueuedFollowUp): FollowUpQueueSnapshot {
    const at = Math.max(0, Math.min(index, this.items.length));
    this.items.splice(at, 0, item);
    this.revision += 1;
    return this.snapshot();
  }

  shift(): { item: QueuedFollowUp; snapshot: FollowUpQueueSnapshot } | null {
    const item = this.items.shift();
    if (!item) return null;
    this.revision += 1;
    return { item, snapshot: this.snapshot() };
  }

  restoreFront(item: QueuedFollowUp): FollowUpQueueSnapshot {
    this.items.unshift(item);
    this.revision += 1;
    return this.snapshot();
  }
}
