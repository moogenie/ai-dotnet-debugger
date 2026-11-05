import type {
  IAgentBreakpoint,
  IAgentControl,
  IBreakpointLocation,
  IControlStatus,
  ILaunchConfigSummary,
  IResumeResult,
  StepKind,
} from "../control/agent-control";
import { AnnotationRefusedError, type IAnnotationInput } from "../annotations/annotation-store";
import { NarrationRefusedError } from "../journal/journal-model";
import type { IAnnotationView, IControlState } from "../journal/webview/journal-protocol";
import type { IWaitOptions, WaitResult } from "../mcp/event-inbox";
import type { ICurrentStop, IOutputTail } from "../session/session-tracker";
import type {
  EvaluationMode,
  IEvaluateOptions,
  IEvaluation,
  ISnapshot,
  ISnapshotLimits,
  ISnapshotVariable,
} from "../session/snapshot.types";
import type { AuditLog } from "./audit-log";
import { classifyExpression } from "./expression-classifier";
import type { Redactor } from "./redaction";

export class ConsentRequiredError extends Error {
  public constructor() {
    super("AI Debugger is not enabled for this workspace. The person must run 'AI Debugger: Enable for this workspace'.");
    this.name = "ConsentRequiredError";
  }
}

export class AgentBlindError extends Error {
  public constructor(public readonly reasons: string[]) {
    super(`The current debug session is hidden from the agent because ${reasons.join("; ")}.`);
    this.name = "AgentBlindError";
  }
}

export class ApprovalRefusedError extends Error {
  public constructor(expression: string) {
    super(`The person did not approve evaluating '${expression}'.`);
    this.name = "ApprovalRefusedError";
  }
}

export class ControlRefusedError extends Error {
  public constructor(reason: string) {
    super(reason);
    this.name = "ControlRefusedError";
  }
}

export interface IAgentSessionSource {
  readonly currentStop: ICurrentStop | undefined;
  readonly sessionId: string | undefined;
  blindReasons(): string[] | undefined;
  evaluate(expression: string, frameIndex: number, options: IEvaluateOptions): Promise<IEvaluation>;
  expand(handle: string, depth: number, limits?: ISnapshotLimits): Promise<ISnapshotVariable[]>;
  snapshot(limits?: ISnapshotLimits): Promise<ISnapshot>;
}

export interface IApprover {
  // Resolves to the mode the person chose, or undefined when they refuse.
  approveEvaluate(expression: string, reason: string): Promise<EvaluationMode | undefined>;
}

export interface IConsentCheck {
  isGranted(): boolean;
}

// Decides whether the agent may change the debugger. The extension's gate is the ControlLock.
// It throws ControlRefusedError to refuse.
export interface IControlGate {
  authorise(tool: string, summary: string): Promise<void>;
  describe(): IControlState;
}

// For unit tests of the gateway alone: it lets every call through, like Watch mode.
export const OPEN_CONTROL_GATE: IControlGate = {
  authorise: (): Promise<void> => Promise.resolve(),
  describe: (): IControlState => ({ holder: "agent", mode: "watch", pending: [] }),
};

// Where the agent's narration goes: the person's Debug Journal.
export interface INarrationSink {
  addNarration(text: string, stopId?: number, answers?: number): { answers?: number; stopId?: number };
}

// Where the agent's line notes go: decorations in the editor. It checks the path and line against the workspace.
export interface IAnnotationSink {
  annotate(input: IAnnotationInput): Promise<IAnnotationView>;
  clear(id?: string): IAnnotationView[];
}

export interface IEventSource {
  discardSessionEvents(): void;
  wait(options: IWaitOptions): Promise<WaitResult>;
}

export interface IAgentGatewayDependencies {
  annotations: IAnnotationSink;
  approver: IApprover;
  audit: AuditLog;
  consent: IConsentCheck;
  control: IAgentControl;
  events: IEventSource;
  gate: IControlGate;
  journal: INarrationSink;
  redactor: () => Redactor;
  sessions: IAgentSessionSource;
}

export interface IAgentStatus extends IControlStatus {
  blindReasons?: string[];
  control: IControlState;
}

interface ICallRules {
  // Reads and resume commands refuse while the person debugs an agent-blind session.
  checksBlind: boolean;
  // Control tools pass the control gate.
  isControl: boolean;
}

const READ: ICallRules = { checksBlind: true, isControl: false };
const INFO: ICallRules = { checksBlind: false, isControl: false };
const SETUP: ICallRules = { checksBlind: false, isControl: true };
const DRIVE: ICallRules = { checksBlind: true, isControl: true };

// The only path from the debug session to the agent. Every call is checked, redacted and audited here,
// so no tool built on top can skip a guardrail.
export class AgentGateway {
  public constructor(private readonly deps: IAgentGatewayDependencies) {}

  public snapshot(limits?: ISnapshotLimits): Promise<ISnapshot> {
    return this.run("get_snapshot", "", READ, () => this.deps.sessions.snapshot(limits));
  }

  public expand(handle: string, depth: number): Promise<ISnapshotVariable[]> {
    return this.run("get_variables", `handle=${handle} depth=${depth}`, READ, () => this.deps.sessions.expand(handle, depth));
  }

  // A plain member path runs under nse without asking. Anything else needs the person's choice of mode,
  // because the nse interpreter can be silently wrong and a real run can change program state.
  public evaluate(expression: string, frameIndex = 0): Promise<IEvaluation> {
    return this.run("evaluate", `frame=${frameIndex} expression=${expression}`, READ, async () => {
      const verdict = classifyExpression(expression);
      if (verdict.isSafe) return this.deps.sessions.evaluate(expression, frameIndex, { isPlainPath: true, mode: "nse" });
      const mode = await this.deps.approver.approveEvaluate(expression, verdict.reason);
      if (!mode) throw new ApprovalRefusedError(expression);
      return this.deps.sessions.evaluate(expression, frameIndex, { isPlainPath: false, mode });
    });
  }

  public output(): Promise<IOutputTail> {
    return this.run("get_output", "", READ, () => Promise.resolve(this.deps.control.output()));
  }

  public status(): Promise<IAgentStatus> {
    return this.run("get_status", "", INFO, () =>
      Promise.resolve({
        ...this.deps.control.status(),
        blindReasons: this.deps.sessions.blindReasons(),
        control: this.deps.gate.describe(),
      }),
    );
  }

  public listLaunchConfigs(): Promise<ILaunchConfigSummary[]> {
    return this.run("list_launch_configs", "", INFO, () => Promise.resolve(this.deps.control.listLaunchConfigs()));
  }

  public waitForEvent(options: IWaitOptions): Promise<WaitResult> {
    return this.run("wait_for_event", `timeoutSeconds=${options.timeoutSeconds ?? "default"}`, INFO, () =>
      this.deps.events.wait(options),
    );
  }

  // The text is redacted before the person sees it, so the Journal and the audit log hold the same words.
  public narrate(text: string, stopId?: number, answers?: number): Promise<{ answers?: number; stopId?: number; text: string }> {
    return this.run("narrate", `stopId=${stopId ?? "none"} answers=${answers ?? "none"} chars=${text.length}`, INFO, () => {
      const redacted = this.deps.redactor().redactText(text);
      return Promise.resolve({ ...this.deps.journal.addNarration(redacted, stopId, answers), text: redacted });
    });
  }

  // Like narrate, the note is redacted before it reaches the editor, so the editor and the audit log match.
  public annotate(input: IAnnotationInput): Promise<IAnnotationView> {
    return this.run("annotate", `${input.path}:${input.line} chars=${input.text.length}`, INFO, () =>
      this.deps.annotations.annotate({ ...input, text: this.deps.redactor().redactText(input.text) }),
    );
  }

  public clearAnnotations(id?: string): Promise<{ cleared: IAnnotationView[] }> {
    return this.run("clear_annotations", `id=${id ?? "all"}`, INFO, () => Promise.resolve({ cleared: this.deps.annotations.clear(id) }));
  }

  public startSession(name: string): Promise<{ name: string; sessionId: string }> {
    return this.run("start_session", `name=${name}`, SETUP, () => {
      this.deps.events.discardSessionEvents();
      return this.deps.control.startSession(name);
    });
  }

  public stopSession(): Promise<{ name: string }> {
    return this.run("stop_session", "", SETUP, () => this.deps.control.stopSession());
  }

  public setBreakpoint(location: IBreakpointLocation): Promise<IAgentBreakpoint> {
    return this.run("set_breakpoint", `${location.path}:${location.line}`, SETUP, () =>
      Promise.resolve(this.deps.control.setBreakpoint(location)),
    );
  }

  public removeBreakpoint(id: string): Promise<IAgentBreakpoint> {
    return this.run("remove_breakpoint", `id=${id}`, SETUP, () => Promise.resolve(this.deps.control.removeBreakpoint(id)));
  }

  public resume(): Promise<IResumeResult> {
    return this.run("continue", "", DRIVE, () => this.deps.control.resume());
  }

  public step(kind: StepKind): Promise<IResumeResult> {
    return this.run("step", `kind=${kind}`, DRIVE, () => this.deps.control.step(kind));
  }

  public pause(): Promise<{ isRequested: true }> {
    return this.run("pause", "", DRIVE, () => this.deps.control.pause());
  }

  private async run<T>(tool: string, argsSummary: string, rules: ICallRules, action: () => Promise<T>): Promise<T> {
    const redactor = this.deps.redactor();
    const safeArgs = redactor.redactText(argsSummary);
    const context = { sessionId: this.deps.sessions.sessionId, stopId: this.deps.sessions.currentStop?.stopId, tool };
    try {
      if (!this.deps.consent.isGranted()) throw new ConsentRequiredError();
      if (rules.checksBlind) {
        const blind = this.deps.sessions.blindReasons();
        if (blind) throw new AgentBlindError(blind);
      }
      if (rules.isControl) await this.deps.gate.authorise(tool, safeArgs);
      const { counts, value } = redactor.redact(await action());
      await this.deps.audit.write({ ...context, argsSummary: safeArgs, outcome: "returned", payload: value, redactions: counts });
      return value;
    } catch (error) {
      const isRefusal =
        error instanceof ConsentRequiredError ||
        error instanceof AgentBlindError ||
        error instanceof ApprovalRefusedError ||
        error instanceof ControlRefusedError ||
        error instanceof NarrationRefusedError ||
        error instanceof AnnotationRefusedError;
      const message = redactor.redactText(error instanceof Error ? error.message : String(error));
      await this.deps.audit.write({
        ...context,
        argsSummary: safeArgs,
        outcome: isRefusal ? "refused" : "failed",
        payload: { error: message },
      });
      if (isRefusal) throw error;
      const redacted = new Error(message);
      redacted.name = error instanceof Error ? error.name : "Error";
      throw redacted;
    }
  }
}
