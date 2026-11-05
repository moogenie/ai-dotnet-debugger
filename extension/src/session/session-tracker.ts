import {
  continuedEventBodySchema,
  exitedEventBodySchema,
  outputEventBodySchema,
  protocolMessageSchema,
  stoppedEventBodySchema,
} from "./dap-contracts";
import type { SessionEventBus } from "./session-events";
import { OUTPUT_TAIL_LINES } from "./session.constants";

const RESUMING_COMMANDS = new Set(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"]);
// Requests that drive the process. disconnect and terminate are left out: stopping a session ends it anyway,
// and VS Code sends them for the agent's own stop_session without going through customRequest.
const CONTROL_COMMANDS = new Set([...RESUMING_COMMANDS, "pause", "goto", "restart", "restartFrame"]);
// An expectation the adapter never saw (the request failed before it was sent) must not hide a later person action.
const EXPECTATION_MS = 10_000;

export interface ICurrentStop {
  reason: string;
  stopId: number;
  threadId?: number;
}

export interface IOutputTail {
  dropped: number;
  lines: string[];
}

// Turns raw messages from the debug adapter into typed session events.
// Holds no VS Code types, so it can be driven directly in unit tests.
export class SessionTracker {
  private currentStop: ICurrentStop | undefined;
  private lastStopId = 0;
  private pendingLine = "";
  private tail: string[] = [];
  private tailDropped = 0;
  private rejected = 0;
  private readonly expected: { at: number; command: string }[] = [];

  public constructor(
    private readonly bus: SessionEventBus,
    private readonly now: () => number = Date.now,
  ) {}

  // The extension is about to send this request itself. The matching request is then not the person's.
  public expectFromExtension(command: string): () => void {
    const entry = { at: this.now(), command };
    this.expected.push(entry);
    return (): void => {
      const index = this.expected.indexOf(entry);
      if (index >= 0) this.expected.splice(index, 1);
    };
  }

  // Messages from VS Code to the adapter. The tagging method was proven in the DAP read spike (spikes/dap-read).
  public fromClient(message: unknown): void {
    const parsed = protocolMessageSchema.safeParse(message);
    if (!parsed.success) return;
    const { command, type } = parsed.data;
    if (type !== "request" || !command || !CONTROL_COMMANDS.has(command)) return;
    const cutoff = this.now() - EXPECTATION_MS;
    while (this.expected[0] && this.expected[0].at < cutoff) this.expected.shift();
    const index = this.expected.findIndex((entry) => entry.command === command);
    if (index >= 0) {
      this.expected.splice(index, 1);
      return;
    }
    this.bus.publish({ command, kind: "person-control" });
  }

  public get stop(): ICurrentStop | undefined {
    return this.currentStop;
  }

  public get rejectedMessages(): number {
    return this.rejected;
  }

  public outputTail(): IOutputTail {
    const lines = this.pendingLine ? [...this.tail, this.pendingLine] : [...this.tail];
    const overflow = Math.max(0, lines.length - OUTPUT_TAIL_LINES);
    return { dropped: this.tailDropped + overflow, lines: lines.slice(overflow) };
  }

  public fromAdapter(message: unknown): void {
    const parsed = protocolMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.rejected++;
      return;
    }
    const { body, command, event, success, type } = parsed.data;
    if (type === "event" && event) {
      this.onEvent(event, body);
    } else if (type === "response" && success === true && command && RESUMING_COMMANDS.has(command)) {
      this.onResumed(command);
    }
  }

  private onEvent(event: string, body: unknown): void {
    switch (event) {
      case "stopped":
        this.onStopped(body);
        return;
      case "continued": {
        const parsed = continuedEventBodySchema.safeParse(body);
        if (parsed.success) this.onResumed("continued-event", parsed.data.threadId);
        else this.rejected++;
        return;
      }
      case "output":
        this.onOutput(body);
        return;
      case "exited": {
        const parsed = exitedEventBodySchema.safeParse(body);
        if (parsed.success) this.bus.publish({ exitCode: parsed.data.exitCode, kind: "exited" });
        else this.rejected++;
        return;
      }
      case "terminated":
        this.currentStop = undefined;
        this.bus.publish({ kind: "terminated" });
        return;
      default:
        return;
    }
  }

  private onStopped(body: unknown): void {
    const parsed = stoppedEventBodySchema.safeParse(body);
    if (!parsed.success) {
      this.rejected++;
      return;
    }
    const { reason, text, threadId } = parsed.data;
    this.lastStopId++;
    this.currentStop = { reason, stopId: this.lastStopId, threadId };
    this.bus.publish({ kind: "stopped", reason, stopId: this.lastStopId, text, threadId });
    if (reason === "exception") {
      this.bus.publish({ kind: "exception", stopId: this.lastStopId, text, threadId });
    }
  }

  // A resume ends the current stop, so variable handles from it go stale.
  // The output tail restarts, so the next snapshot carries only output since this stop.
  private onResumed(cause: string, threadId?: number): void {
    if (!this.currentStop) return;
    const { stopId } = this.currentStop;
    this.currentStop = undefined;
    this.tail = [];
    this.tailDropped = 0;
    this.bus.publish({ cause, kind: "continued", stopId, threadId });
  }

  private onOutput(body: unknown): void {
    const parsed = outputEventBodySchema.safeParse(body);
    if (!parsed.success) {
      this.rejected++;
      return;
    }
    const category = parsed.data.category ?? "console";
    this.bus.publish({ category, kind: "output", text: parsed.data.output });
    if (category === "telemetry") return;
    const parts = (this.pendingLine + parsed.data.output).split(/\r?\n/);
    this.pendingLine = parts.pop() ?? "";
    this.tail.push(...parts);
    const overflow = this.tail.length - OUTPUT_TAIL_LINES;
    if (overflow > 0) {
      this.tail.splice(0, overflow);
      this.tailDropped += overflow;
    }
  }
}
