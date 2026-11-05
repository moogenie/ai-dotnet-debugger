import {
  evaluateResponseSchema,
  exceptionInfoResponseSchema,
  scopesResponseSchema,
  stackTraceResponseSchema,
  threadsResponseSchema,
  variablesResponseSchema,
  type IDapVariable,
  type IStackFrame,
} from "./dap-contracts";
import type { ICurrentStop, IOutputTail } from "./session-tracker";
import {
  DEFAULT_DEPTH,
  LOCALS_SCOPE_NAME,
  MAX_CHILDREN,
  MAX_DEPTH,
  MAX_FRAMES,
  MAX_PAYLOAD_BYTES,
  MAX_VALUE_CHARS,
  WATCHES_UNAVAILABLE_REASON,
} from "./session.constants";
import type {
  IDapClient,
  IEvaluateOptions,
  IEvaluation,
  ISnapshot,
  ISnapshotException,
  ISnapshotFrame,
  ISnapshotLimits,
  ISnapshotVariable,
  ValueAccuracy,
} from "./snapshot.types";
import type { VariableHandles } from "./variable-handles";
import { isLiteralValue, stripTypeSuffix, toForwardSlashes, truncate, withNse, withoutNse } from "./variable-names";

export const DEFAULT_LIMITS: ISnapshotLimits = {
  depth: DEFAULT_DEPTH,
  maxChildren: MAX_CHILDREN,
  maxFrames: MAX_FRAMES,
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
  maxValueChars: MAX_VALUE_CHARS,
};

const FAILED_EVALUATION = "failedEvaluation";

export class SnapshotBuilder {
  public constructor(
    private readonly client: IDapClient,
    private readonly handles: VariableHandles,
    private readonly toSourcePath: (path: string) => string = toForwardSlashes,
  ) {}

  public async build(stop: ICurrentStop, output: IOutputTail, limits: ISnapshotLimits = DEFAULT_LIMITS): Promise<ISnapshot> {
    this.handles.ensureStop(stop.stopId);
    const threadId = stop.threadId ?? (await this.firstThreadId());
    const threadName = await this.threadName(threadId);
    // One extra frame is requested because vsdbg may omit totalFrames; it shows whether frames were cut.
    const stack = stackTraceResponseSchema.parse(
      await this.client.request("stackTrace", { levels: limits.maxFrames + 1, startFrame: 0, threadId }),
    );
    const kept = stack.stackFrames.slice(0, limits.maxFrames);
    const frames = kept.map((frame) => this.toFrame(frame));
    const isFramesOmittedExact = stack.totalFrames !== undefined;
    const framesOmitted = Math.max(0, (stack.totalFrames ?? stack.stackFrames.length) - kept.length);
    const top = kept[0];

    const snapshot: ISnapshot = {
      exception: stop.reason === "exception" ? await this.exceptionInfo(threadId) : undefined,
      frames,
      locals: top ? await this.readLocals(top.id, limits) : [],
      outputTail: output.lines,
      reason: stop.reason,
      stopId: stop.stopId,
      thread: { id: threadId, name: threadName },
      truncation: {
        framesOmitted,
        isFramesOmittedExact,
        localsChildrenDropped: 0,
        localsDropped: 0,
        outputLinesDropped: output.dropped,
        payloadCapApplied: false,
      },
      watches: { isAvailable: false, reason: WATCHES_UNAVAILABLE_REASON },
    };
    return applyPayloadCap(snapshot, limits.maxPayloadBytes);
  }

  // Only the top frame, for the person's Journal. It reads no variables, so it runs no getters.
  public async topFrame(stop: ICurrentStop): Promise<ISnapshotFrame | undefined> {
    const threadId = stop.threadId ?? (await this.firstThreadId());
    const stack = stackTraceResponseSchema.parse(await this.client.request("stackTrace", { levels: 1, startFrame: 0, threadId }));
    const top = stack.stackFrames[0];
    return top ? this.toFrame(top) : undefined;
  }

  public async expand(
    handle: string,
    currentStopId: number | undefined,
    depth: number,
    limits: ISnapshotLimits = DEFAULT_LIMITS,
  ): Promise<ISnapshotVariable[]> {
    const reference = this.handles.resolve(handle, currentStopId);
    const levels = Math.min(Math.max(depth, 1), MAX_DEPTH);
    return this.expandChildren(reference, levels, limits);
  }

  // The Locals scope is listed once, only to learn the names. Every value is then read through nse.
  private async readLocals(frameId: number, limits: ISnapshotLimits): Promise<ISnapshotVariable[]> {
    const scopes = scopesResponseSchema.parse(await this.client.request("scopes", { frameId }));
    const locals = scopes.scopes.find((scope) => scope.name === LOCALS_SCOPE_NAME) ?? scopes.scopes[0];
    if (!locals) return [];
    const listing = variablesResponseSchema.parse(
      await this.client.request("variables", { variablesReference: locals.variablesReference }),
    );
    const names = listing.variables.map((variable) => stripTypeSuffix(variable.name));
    const result: ISnapshotVariable[] = [];
    for (const name of names) {
      result.push(await this.readLocal(name, frameId, limits));
    }
    return result;
  }

  // Under nse the expression always goes out with nse appended, whatever the caller passed in.
  // A real run sends it without nse and returns the value only: expanding its children would run getters for real.
  public async evaluate(stop: ICurrentStop, expression: string, frameIndex: number, options: IEvaluateOptions): Promise<IEvaluation> {
    this.handles.ensureStop(stop.stopId);
    const threadId = stop.threadId ?? (await this.firstThreadId());
    const stack = stackTraceResponseSchema.parse(
      await this.client.request("stackTrace", { levels: frameIndex + 1, startFrame: 0, threadId }),
    );
    const frame = stack.stackFrames[frameIndex];
    if (!frame) throw new Error(`Frame ${frameIndex} does not exist at this stop.`);
    const limits = options.limits ?? DEFAULT_LIMITS;
    if (options.mode === "real") {
      const sentExpression = withoutNse(expression);
      const variable = await this.readExpression(expression, sentExpression, frame.id, { ...limits, depth: 0 }, "executed");
      delete variable.handle;
      return { mode: "real", sentExpression, stopId: stop.stopId, variable };
    }
    const sentExpression = withNse(expression);
    const variable = await this.readExpression(
      expression,
      sentExpression,
      frame.id,
      limits,
      options.isPlainPath ? undefined : "interpreted",
    );
    return { mode: "nse", sentExpression, stopId: stop.stopId, variable };
  }

  private readLocal(name: string, frameId: number, limits: ISnapshotLimits): Promise<ISnapshotVariable> {
    return this.readExpression(name, withNse(name), frameId, limits);
  }

  private async readExpression(
    name: string,
    sentExpression: string,
    frameId: number,
    limits: ISnapshotLimits,
    forcedAccuracy?: ValueAccuracy,
  ): Promise<ISnapshotVariable> {
    try {
      const response = evaluateResponseSchema.parse(
        await this.client.request("evaluate", { context: "watch", expression: sentExpression, frameId }),
      );
      const shown = truncate(response.result, limits.maxValueChars);
      const variable: ISnapshotVariable = {
        accuracy: forcedAccuracy ?? accuracyOf(response.presentationHint?.kind, response.result),
        isValueTruncated: shown.isTruncated || undefined,
        kind: response.presentationHint?.kind,
        name,
        type: response.type,
        value: shown.value,
      };
      if (response.variablesReference > 0) {
        variable.handle = this.handles.register(response.variablesReference);
        if (limits.depth > 0) {
          await this.attachChildren(variable, response.variablesReference, limits.depth, limits);
        }
      }
      return variable;
    } catch (error) {
      return { isEvaluationFailed: true, name, value: errorText(error) };
    }
  }

  private async attachChildren(
    parent: ISnapshotVariable,
    reference: number,
    levels: number,
    limits: ISnapshotLimits,
  ): Promise<void> {
    const listing = variablesResponseSchema.parse(
      await this.client.request("variables", { variablesReference: reference }),
    );
    const kept = listing.variables.slice(0, limits.maxChildren);
    const omitted = listing.variables.length - kept.length;
    parent.children = [];
    if (omitted > 0) parent.childrenOmitted = omitted;
    for (const child of kept) {
      parent.children.push(await this.toVariable(child, levels - 1, limits));
    }
  }

  private async expandChildren(reference: number, levels: number, limits: ISnapshotLimits): Promise<ISnapshotVariable[]> {
    const holder: ISnapshotVariable = { name: "", value: "" };
    await this.attachChildren(holder, reference, levels, limits);
    return holder.children ?? [];
  }

  private async toVariable(source: IDapVariable, levelsLeft: number, limits: ISnapshotLimits): Promise<ISnapshotVariable> {
    const shown = truncate(source.value, limits.maxValueChars);
    const isFailed = source.presentationHint?.attributes?.includes(FAILED_EVALUATION) ?? false;
    const variable: ISnapshotVariable = {
      accuracy: accuracyOf(source.presentationHint?.kind, source.value),
      isEvaluationFailed: isFailed || undefined,
      isValueTruncated: shown.isTruncated || undefined,
      kind: source.presentationHint?.kind,
      name: stripTypeSuffix(source.name),
      type: source.type,
      value: shown.value,
    };
    if (source.variablesReference > 0) {
      variable.handle = this.handles.register(source.variablesReference);
      if (levelsLeft > 0) await this.attachChildren(variable, source.variablesReference, levelsLeft, limits);
    }
    return variable;
  }

  private toFrame(frame: IStackFrame): ISnapshotFrame {
    const path = frame.source?.path;
    return {
      column: frame.column,
      isUserCode:
        path !== undefined && frame.source?.presentationHint !== "deemphasize" && frame.presentationHint !== "subtle",
      line: frame.line,
      name: frame.name,
      source: path === undefined ? undefined : this.toSourcePath(path),
    };
  }

  private async firstThreadId(): Promise<number> {
    const threads = threadsResponseSchema.parse(await this.client.request("threads", {}));
    const first = threads.threads[0];
    if (!first) throw new Error("The debug adapter reported no threads.");
    return first.id;
  }

  private async threadName(threadId: number): Promise<string | undefined> {
    try {
      const threads = threadsResponseSchema.parse(await this.client.request("threads", {}));
      return threads.threads.find((thread) => thread.id === threadId)?.name;
    } catch {
      return undefined;
    }
  }

  private async exceptionInfo(threadId: number): Promise<ISnapshotException | undefined> {
    try {
      const info = exceptionInfoResponseSchema.parse(await this.client.request("exceptionInfo", { threadId }));
      return {
        breakMode: info.breakMode,
        description: info.description,
        exceptionId: info.exceptionId,
        stackTrace: info.details?.stackTrace,
      };
    } catch {
      return undefined;
    }
  }
}

function accuracyOf(kind: string | undefined, value: string): ValueAccuracy | undefined {
  if (value === "") return undefined;
  return kind === "data" && isLiteralValue(value) ? "exact" : "interpreted";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function payloadBytes(snapshot: ISnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}

// Drops the deepest detail first: children of the last locals, then old output, then whole locals.
export function applyPayloadCap(snapshot: ISnapshot, maxBytes: number): ISnapshot {
  if (payloadBytes(snapshot) <= maxBytes) return snapshot;
  snapshot.truncation.payloadCapApplied = true;
  for (let i = snapshot.locals.length - 1; i >= 0 && payloadBytes(snapshot) > maxBytes; i--) {
    const local = snapshot.locals[i];
    if (local?.children) {
      snapshot.truncation.localsChildrenDropped += local.children.length;
      local.childrenOmitted = (local.childrenOmitted ?? 0) + local.children.length;
      delete local.children;
    }
  }
  while (snapshot.outputTail.length > 0 && payloadBytes(snapshot) > maxBytes) {
    snapshot.outputTail.shift();
    snapshot.truncation.outputLinesDropped++;
  }
  while (snapshot.locals.length > 0 && payloadBytes(snapshot) > maxBytes) {
    snapshot.locals.pop();
    snapshot.truncation.localsDropped++;
  }
  return snapshot;
}
