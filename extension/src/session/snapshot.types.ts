export interface IDapClient {
  request(command: string, args: object): Promise<unknown>;
}

export interface ISnapshotLimits {
  depth: number;
  maxChildren: number;
  maxFrames: number;
  maxPayloadBytes: number;
  maxValueChars: number;
}

// exact: read from memory. interpreted: computed by the nse interpreter, which can be silently wrong.
// executed: run for real after the person approved it.
export type ValueAccuracy = "exact" | "executed" | "interpreted";

export type EvaluationMode = "nse" | "real";

export interface ISnapshotVariable {
  accuracy?: ValueAccuracy;
  children?: ISnapshotVariable[];
  childrenOmitted?: number;
  handle?: string;
  isEvaluationFailed?: boolean;
  isValueTruncated?: boolean;
  kind?: string;
  name: string;
  type?: string;
  value: string;
}

export interface IEvaluateOptions {
  // Set by the caller that classified the expression: a plain member path reads memory, anything else computes.
  isPlainPath: boolean;
  limits?: ISnapshotLimits;
  mode: EvaluationMode;
}

export interface IEvaluation {
  mode: EvaluationMode;
  sentExpression: string;
  stopId: number;
  variable: ISnapshotVariable;
}

export interface ISnapshotFrame {
  column: number;
  isUserCode: boolean;
  line: number;
  name: string;
  source?: string;
}

export interface ISnapshotException {
  breakMode: string;
  description?: string;
  exceptionId: string;
  stackTrace?: string;
}

export interface ISnapshotTruncation {
  framesOmitted: number;
  isFramesOmittedExact: boolean;
  localsChildrenDropped: number;
  localsDropped: number;
  outputLinesDropped: number;
  payloadCapApplied: boolean;
}

export interface ISnapshot {
  exception?: ISnapshotException;
  frames: ISnapshotFrame[];
  locals: ISnapshotVariable[];
  outputTail: string[];
  reason: string;
  stopId: number;
  thread: { id: number; name?: string };
  truncation: ISnapshotTruncation;
  watches: { isAvailable: false; reason: string };
}
