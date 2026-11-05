// The messages between the extension and the Debug Journal webview. Types only, so the webview build can share them.

export interface IStopLocation {
  line: number;
  name: string;
  source?: string;
}

// pending: the extension is still asking the debugger. unavailable: the debugger did not report a location.
// resumed: the process resumed before the debugger answered, which happens when the agent steps at once.
export type LocationState = "pending" | "reported" | "resumed" | "unavailable";

export type ControlMode = "observe" | "pair" | "watch";
export type ControlHolder = "agent" | "person";
export type ProposalDecision = "approved" | "cancelled" | "expired" | "rejected";
export type ProposalStatus = ProposalDecision | "pending";

export interface IProposalView {
  at: string;
  decidedAt?: string;
  id: string;
  reason?: string;
  status: ProposalStatus;
  stopId?: number;
  summary: string;
  tool: string;
}

export interface IAnnotationView {
  at: string;
  id: string;
  line: number;
  path: string;
  stopId?: number;
  text: string;
}

export interface IControlState {
  holder: ControlHolder;
  mode: ControlMode;
  pending: IProposalView[];
}

export interface INarration {
  at: string;
  text: string;
}

export interface ISessionItem {
  at: string;
  id: number;
  kind: "session";
  name: string;
}

export interface IStopItem {
  at: string;
  id: number;
  kind: "stop";
  location?: IStopLocation;
  locationState: LocationState;
  narrations: INarration[];
  reason: string;
  resumedBy?: string;
  stopId: number;
  text?: string;
}

export interface INoteItem {
  at: string;
  id: number;
  kind: "note";
  text: string;
}

export interface IQuestionItem {
  // The agent's answers, linked by narrate's answers field. Shown under the question.
  answers?: INarration[];
  at: string;
  deliveredAt?: string;
  id: number;
  kind: "question";
  location?: IStopLocation;
  stopId?: number;
  text: string;
}

export interface IExitItem {
  at: string;
  exitCode?: number;
  id: number;
  kind: "exited";
}

export interface IProposalItem {
  at: string;
  id: number;
  kind: "proposal";
  proposal: IProposalView;
}

export interface IControlItem {
  at: string;
  cause?: string;
  change: "handed_back" | "mode" | "taken";
  id: number;
  kind: "control";
  mode?: ControlMode;
}

export interface IAnnotationItem {
  annotation: IAnnotationView;
  at: string;
  clearedAt?: string;
  clearedBecause?: string;
  id: number;
  kind: "annotation";
}

export type JournalItem = IAnnotationItem | IControlItem | IExitItem | INoteItem | IProposalItem | IQuestionItem | ISessionItem | IStopItem;

export interface IJournalState {
  control: IControlState;
  currentStopId?: number;
  isAgentListening: boolean;
  isEnabled: boolean;
  items: JournalItem[];
  itemsOmitted: number;
}

export type HostMessage = { state: IJournalState; type: "state" } | { message: string; type: "error" };

export type WebviewMessage =
  | { type: "ready" }
  | { text: string; type: "ask" }
  | { type: "clear" }
  | { decision: "approved" | "rejected"; proposalId: string; type: "decide" }
  | { mode: ControlMode; type: "mode" }
  | { type: "take" }
  | { type: "handBack" }
  | { annotationId: string; type: "dismiss" };

export const MAX_QUESTION_CHARS = 2000;
