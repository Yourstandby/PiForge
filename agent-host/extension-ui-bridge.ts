/**
 * In-process ExtensionUIContext that emits SSE-style events and waits for
 * HTTP `extension_ui_response` commands to resolve dialogs.
 */
import { randomUUID } from "crypto";

export type ExtensionUiMethod = "confirm" | "select" | "input" | "editor";

export type ExtensionUiRequestEvent = {
  type: "extension_ui_request";
  id: string;
  method: ExtensionUiMethod;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
};

export type ExtensionUiNotifyEvent = {
  type: "extension_ui_notify";
  message: string;
  notifyType: "info" | "warning" | "error";
};

export type ExtensionUiResponse = {
  id: string;
  confirmed?: boolean;
  value?: string;
  cancelled?: boolean;
};

type Deferred = {
  method: ExtensionUiMethod;
  resolve: (value: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type ExtensionUiEmit = (event: ExtensionUiRequestEvent | ExtensionUiNotifyEvent) => void;

export type ExtensionUiDialogOptions = {
  signal?: AbortSignal;
  timeout?: number;
};

/**
 * Copy every prototype member of `target` onto the instance itself, enumerable
 * and with `this` already bound.
 *
 * pi's `ExtensionRunner.wrapUIPromptContext()` re-creates the extension UI
 * context with an object spread (`{ ...ui, select: ... }`), which only copies
 * own enumerable properties. A class instance keeps every UI method on its
 * prototype, so the spread used to produce a context that still reported
 * `hasUI === true` while `notify` (and every other method) was gone: extensions
 * like raw-guard crashed with "ctx.ui.notify is not a function" and the whole
 * codemode script was reported as failed. Hoisting the members onto the
 * instance makes the spread-based wrapper lossless.
 */
function exposeUIOnInstance(target: object): void {
  const proto = Object.getPrototypeOf(target) as object | null;
  if (!proto || proto === Object.prototype) return;
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === "constructor" || Object.prototype.hasOwnProperty.call(target, key)) continue;
    const desc = Object.getOwnPropertyDescriptor(proto, key);
    if (!desc) continue;
    if (typeof desc.value === "function") {
      Object.defineProperty(target, key, {
        value: (desc.value as (...args: unknown[]) => unknown).bind(target),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else if (desc.get) {
      Object.defineProperty(target, key, {
        get: desc.get.bind(target),
        enumerable: true,
        configurable: true,
      });
    }
  }
}

/**
 * Bridge implementing the dialog + notify subset of ExtensionUIContext.
 * TUI-only methods are provided as no-ops so bindExtensions can use it as mode "rpc".
 */
export class ExtensionUiBridge {
  private pending = new Map<string, Deferred>();
  /** Request payloads kept so a late SSE subscriber can still render the dialog. */
  private pendingEvents = new Map<string, ExtensionUiRequestEvent>();
  private destroyed = false;
  private emit: ExtensionUiEmit;

  constructor(emit: ExtensionUiEmit) {
    this.emit = emit;
    exposeUIOnInstance(this);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Requests still waiting for a response. The SSE route replays these to every
   * new subscriber: an extension can open a dialog while the renderer has not
   * attached yet (first message of a brand-new session), and without the replay
   * the event is lost and the agent waits forever.
   */
  pendingRequests(): ExtensionUiRequestEvent[] {
    return [...this.pendingEvents.values()];
  }

  destroy(): void {
    this.destroyed = true;
    for (const d of this.pending.values()) {
      if (d.timer) clearTimeout(d.timer);
      d.resolve(d.method === "confirm" ? false : undefined);
    }
    this.pending.clear();
    this.pendingEvents.clear();
  }

  /**
   * Resolve a pending dialog from an agent command.
   * @returns null on success, error message string on failure.
   */
  respond(response: ExtensionUiResponse): string | null {
    const d = this.pending.get(response.id);
    if (!d) return "Unknown or expired UI request";
    if (d.timer) clearTimeout(d.timer);
    this.pending.delete(response.id);
    this.pendingEvents.delete(response.id);

    if (response.cancelled) {
      d.resolve(d.method === "confirm" ? false : undefined);
      return null;
    }
    if (d.method === "confirm") {
      d.resolve(response.confirmed === true);
      return null;
    }
    if (typeof response.value === "string") {
      d.resolve(response.value);
      return null;
    }
    d.resolve(undefined);
    return null;
  }

  private enqueue<T>(
    method: ExtensionUiMethod,
    payload: Omit<ExtensionUiRequestEvent, "type" | "id" | "method">,
    opts?: ExtensionUiDialogOptions
  ): Promise<T> {
    if (this.destroyed) {
      return Promise.resolve((method === "confirm" ? false : undefined) as T);
    }
    const id = randomUUID();
    const event: ExtensionUiRequestEvent = {
      type: "extension_ui_request",
      id,
      method,
      ...payload,
    };
    if (opts?.timeout != null) event.timeout = opts.timeout;

    return new Promise<T>((resolve) => {
      const deferred: Deferred = {
        method,
        resolve: (v) => resolve(v as T),
      };
      if (opts?.timeout != null && opts.timeout > 0) {
        deferred.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.pendingEvents.delete(id);
          resolve((method === "confirm" ? false : undefined) as T);
        }, opts.timeout);
      }
      if (opts?.signal) {
        const onAbort = () => {
          if (!this.pending.has(id)) return;
          if (deferred.timer) clearTimeout(deferred.timer);
          this.pending.delete(id);
          this.pendingEvents.delete(id);
          resolve((method === "confirm" ? false : undefined) as T);
        };
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, deferred);
      this.pendingEvents.set(id, event);
      try {
        this.emit(event);
      } catch (err) {
        if (deferred.timer) clearTimeout(deferred.timer);
        this.pending.delete(id);
        this.pendingEvents.delete(id);
        resolve((method === "confirm" ? false : undefined) as T);
        console.error("extension_ui emit failed:", err);
      }
    });
  }

  // --- ExtensionUIContext dialog subset ---

  select(title: string, options: string[], opts?: ExtensionUiDialogOptions): Promise<string | undefined> {
    return this.enqueue("select", { title, options }, opts);
  }

  confirm(title: string, message: string, opts?: ExtensionUiDialogOptions): Promise<boolean> {
    return this.enqueue("confirm", { title, message }, opts);
  }

  input(title: string, placeholder?: string, opts?: ExtensionUiDialogOptions): Promise<string | undefined> {
    return this.enqueue("input", { title, placeholder }, opts);
  }

  editor(title: string, prefill?: string, opts?: ExtensionUiDialogOptions): Promise<string | undefined> {
    return this.enqueue("editor", { title, prefill }, opts);
  }

  notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    if (this.destroyed) return;
    this.emit({ type: "extension_ui_notify", message, notifyType: type });
  }

  // --- no-op stubs for the rest of ExtensionUIContext ---

  onTerminalInput(): () => void {
    return () => {};
  }
  setStatus(): void {}
  setWorkingMessage(): void {}
  setWorkingVisible(): void {}
  setWorkingIndicator(): void {}
  setHiddenThinkingLabel(): void {}
  setWidget(): void {}
  setFooter(): void {}
  setHeader(): void {}
  setTitle(): void {}
  custom(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
  setEditorComponent(): void {}
  getEditorComponent(): undefined {
    return undefined;
  }
  addAutocompleteProvider(): void {}
  getEditorText(): string {
    return "";
  }
  setEditorText(): void {}
  pasteToEditor(): void {}
  getToolsExpanded(): boolean {
    return false;
  }
  setToolsExpanded(): void {}
  getAllThemes(): never[] {
    return [];
  }
  getTheme(): undefined {
    return undefined;
  }
  setTheme(): { success: false; error: string } {
    return { success: false, error: "Themes not supported in desktop UI mode" };
  }
  /** Required by ExtensionUIContext; desktop has no TUI theme object. */
  get theme(): never {
    return undefined as never;
  }
}
