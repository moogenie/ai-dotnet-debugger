import * as vscode from "vscode";
import { assessSession } from "../guardrails/session-eligibility";
import { SessionEventBus, type IDisposable, type SessionEventListener } from "./session-events";
import { SessionTracker, type ICurrentStop, type IOutputTail } from "./session-tracker";
import { SUPPORTED_DEBUG_TYPE } from "./session.constants";
import { DEFAULT_LIMITS, SnapshotBuilder } from "./snapshot-builder";
import type {
  IDapClient,
  IEvaluateOptions,
  IEvaluation,
  ISnapshot,
  ISnapshotFrame,
  ISnapshotLimits,
  ISnapshotVariable,
} from "./snapshot.types";
import { VariableHandles } from "./variable-handles";
import { toForwardSlashes } from "./variable-names";

export class NoStoppedSessionError extends Error {
  public constructor() {
    super("No supported debug session is stopped.");
    this.name = "NoStoppedSessionError";
  }
}

export class NoSessionError extends Error {
  public constructor() {
    super("No agent-visible debug session is running.");
    this.name = "NoSessionError";
  }
}

interface IActiveSession {
  builder: SnapshotBuilder;
  session: vscode.DebugSession;
  tracker: SessionTracker;
}

// Owns the one agent-visible coreclr session the extension follows. A second concurrent session is ignored.
// An agent-blind session is never followed, so nothing can be read from it.
export class SessionManager implements vscode.Disposable {
  private readonly bus = new SessionEventBus();
  private readonly disposables: vscode.Disposable[] = [];
  private active: IActiveSession | undefined;

  public constructor() {
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory(SUPPORTED_DEBUG_TYPE, {
        createDebugAdapterTracker: (session) => this.createTracker(session),
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        if (this.active?.session.id === session.id) this.active = undefined;
      }),
    );
  }

  public get session(): vscode.DebugSession | undefined {
    return this.active?.session;
  }

  public get currentStop(): ICurrentStop | undefined {
    return this.active?.tracker.stop;
  }

  public get sessionId(): string | undefined {
    return this.active?.session.id;
  }

  // Why the session the person is debugging is hidden from the agent, if it is.
  public blindReasons(): string[] | undefined {
    const debugging = vscode.debug.activeDebugSession;
    if (!debugging || debugging.id === this.active?.session.id) return undefined;
    const { reasons } = assessSession(debugging.configuration);
    return reasons.length > 0 ? reasons : undefined;
  }

  public onEvent(listener: SessionEventListener): IDisposable {
    return this.bus.subscribe(listener);
  }

  public async snapshot(limits: ISnapshotLimits = DEFAULT_LIMITS): Promise<ISnapshot> {
    const { builder, stop, tracker } = this.requireStop();
    return builder.build(stop, tracker.outputTail(), limits);
  }

  public async expand(handle: string, depth: number, limits: ISnapshotLimits = DEFAULT_LIMITS): Promise<ISnapshotVariable[]> {
    const active = this.active;
    if (!active) throw new NoStoppedSessionError();
    return active.builder.expand(handle, active.tracker.stop?.stopId, depth, limits);
  }

  // Where the given stop is, for the person's Journal. undefined when the stop is no longer current
  // or the debugger reports no frame.
  public async topFrame(stopId: number): Promise<ISnapshotFrame | undefined> {
    const active = this.active;
    const stop = active?.tracker.stop;
    if (!active || stop?.stopId !== stopId) return undefined;
    return active.builder.topFrame(stop);
  }

  public outputTail(): IOutputTail {
    if (!this.active) throw new NoSessionError();
    return this.active.tracker.outputTail();
  }

  // Sends a control request to the followed session. Callers check the stop state first.
  // The tracker is told first, so it never mistakes the extension's own request for the person's.
  public async request(command: string, args: object): Promise<unknown> {
    if (!this.active) throw new NoSessionError();
    const forget = this.active.tracker.expectFromExtension(command);
    try {
      return await this.active.session.customRequest(command, args);
    } catch (error) {
      forget();
      throw error;
    }
  }

  public async evaluate(expression: string, frameIndex: number, options: IEvaluateOptions): Promise<IEvaluation> {
    const { builder, stop } = this.requireStop();
    return builder.evaluate(stop, expression, frameIndex, options);
  }

  public dispose(): void {
    this.disposables.forEach((disposable) => void disposable.dispose());
  }

  private requireStop(): IActiveSession & { stop: ICurrentStop } {
    const stop = this.active?.tracker.stop;
    if (!this.active || !stop) throw new NoStoppedSessionError();
    return { ...this.active, stop };
  }

  private createTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker | undefined {
    if (this.active || !assessSession(session.configuration).isAgentVisible) return undefined;
    const tracker = new SessionTracker(this.bus);
    const client: IDapClient = {
      request: async (command, args): Promise<unknown> => session.customRequest(command, args),
    };
    const builder = new SnapshotBuilder(client, new VariableHandles(), toWorkspacePath);
    this.active = { builder, session, tracker };
    this.bus.publish({ kind: "started", name: session.name, sessionId: session.id });
    return {
      onDidSendMessage: (message: unknown): void => tracker.fromAdapter(message),
      onWillReceiveMessage: (message: unknown): void => tracker.fromClient(message),
    };
  }
}

function toWorkspacePath(path: string): string {
  return toForwardSlashes(vscode.workspace.asRelativePath(path, false));
}
