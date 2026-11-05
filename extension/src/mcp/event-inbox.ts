import type { ControlEvent } from "../control/control-lock";
import type { IStopLocation } from "../journal/webview/journal-protocol";
import type { SessionEvent } from "../session/session-events";
import { INBOX_CAPACITY, MAX_WAIT_SECONDS, PROGRESS_INTERVAL_MS } from "./mcp.constants";

const MS_PER_SECOND = 1000;

// The event kinds that wait_for_event delivers to the agent.
export type AgentEvent =
  | ControlEvent
  | { kind: "stopped"; reason: string; stopId: number; text?: string; threadId?: number }
  | { cause: string; kind: "continued"; stopId: number }
  | { exitCode?: number; kind: "exited" }
  | { kind: "question"; location?: IStopLocation; questionId?: number; stopId?: number; text: string };

export type InboxItem = AgentEvent & { at: string; sequence: number };

export type WaitResult =
  | { event: InboxItem; kind: "event"; droppedBefore: number }
  | { kind: "timeout"; waitedSeconds: number }
  | { kind: "cancelled" };

export interface IWaitOptions {
  onProgress?: (elapsedSeconds: number) => void;
  signal?: AbortSignal;
  timeoutSeconds?: number;
}

interface IWaiter {
  deliver(item: InboxItem): void;
}

export interface IInboxListener {
  // An item reached the agent: a wait returned it.
  onDelivered?(item: InboxItem): void;
  // A wait started or ended, so isListening may have changed.
  onListeningChanged?(): void;
}

// One inbox for stops and the person's questions, so the agent runs a single wait loop.
// When nobody reads it, the oldest events fall off and the next reader is told how many.
export class EventInbox {
  private readonly items: InboxItem[] = [];
  private readonly waiters: IWaiter[] = [];
  private readonly listeners = new Set<IInboxListener>();
  private dropped = 0;
  private lastExitCode: number | undefined;
  private sequence = 0;

  public constructor(
    private readonly capacity = INBOX_CAPACITY,
    private readonly now: () => Date = (): Date => new Date(),
  ) {}

  public get isListening(): boolean {
    return this.waiters.length > 0;
  }

  public listen(listener: IInboxListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: (): void => void this.listeners.delete(listener) };
  }

  public get pending(): number {
    return this.items.length;
  }

  // Maps raw session events to agent events. Output stays out of the inbox: get_output reads it on demand.
  public fromSession(event: SessionEvent): void {
    switch (event.kind) {
      case "stopped":
        this.push({ kind: "stopped", reason: event.reason, stopId: event.stopId, text: event.text, threadId: event.threadId });
        return;
      case "continued":
        this.push({ cause: event.cause, kind: "continued", stopId: event.stopId });
        return;
      case "exited":
        this.lastExitCode = event.exitCode;
        return;
      case "terminated":
        this.push({ exitCode: this.lastExitCode, kind: "exited" });
        this.lastExitCode = undefined;
        return;
      default:
        return;
    }
  }

  public push(event: AgentEvent): void {
    this.sequence++;
    const item: InboxItem = { ...event, at: this.now().toISOString(), sequence: this.sequence };
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.deliver(item);
      return;
    }
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped++;
    }
  }

  // A new session makes earlier stops meaningless, so they go. The person's questions stay.
  public discardSessionEvents(): void {
    const kept = this.items.filter((item) => item.kind === "question");
    this.items.splice(0, this.items.length, ...kept);
    this.dropped = 0;
  }

  public wait(options: IWaitOptions = {}): Promise<WaitResult> {
    const timeoutSeconds = Math.min(Math.max(options.timeoutSeconds ?? MAX_WAIT_SECONDS, 1), MAX_WAIT_SECONDS);
    const queued = this.items.shift();
    if (queued) return Promise.resolve(this.eventResult(queued));
    if (options.signal?.aborted) return Promise.resolve({ kind: "cancelled" });

    return new Promise((resolve) => {
      const started = Date.now();
      const finish = (result: WaitResult): void => {
        clearTimeout(timer);
        clearInterval(progress);
        options.signal?.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        this.notifyListening();
        resolve(result);
      };
      const waiter: IWaiter = { deliver: (item) => finish(this.eventResult(item)) };
      const onAbort = (): void => finish({ kind: "cancelled" });
      const timer = setTimeout(() => finish({ kind: "timeout", waitedSeconds: timeoutSeconds }), timeoutSeconds * MS_PER_SECOND);
      const progress = setInterval(
        () => options.onProgress?.(Math.round((Date.now() - started) / MS_PER_SECOND)),
        PROGRESS_INTERVAL_MS,
      );
      options.signal?.addEventListener("abort", onAbort);
      this.waiters.push(waiter);
      this.notifyListening();
    });
  }

  private eventResult(item: InboxItem): WaitResult {
    const droppedBefore = this.dropped;
    this.dropped = 0;
    for (const listener of this.listeners) listener.onDelivered?.(item);
    return { droppedBefore, event: item, kind: "event" };
  }

  private notifyListening(): void {
    for (const listener of this.listeners) listener.onListeningChanged?.();
  }
}
