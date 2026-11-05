import * as path from "node:path";
import type { IOutputTail } from "../session/session-tracker";
import { toForwardSlashes } from "../session/variable-names";

export type StepKind = "into" | "out" | "over";

export const STEP_COMMANDS: Readonly<Record<StepKind, string>> = { into: "stepIn", out: "stepOut", over: "next" };

export interface ILaunchConfigSummary {
  isAgentVisible: boolean;
  name: string;
  reasons: string[];
  request?: string;
  type?: string;
}

export interface IBreakpointLocation {
  line: number;
  path: string;
}

export interface IAgentBreakpoint extends IBreakpointLocation {
  id: string;
}

export interface IPersonBreakpoint extends IBreakpointLocation {
  isEnabled: boolean;
}

export interface IResumeResult {
  command: string;
  resumedFromStopId: number;
}

export interface ISessionStatus {
  id: string;
  name: string;
  reason?: string;
  state: "running" | "stopped";
  stopId?: number;
}

export interface IControlStatus {
  agentBreakpoints: IAgentBreakpoint[];
  personBreakpoints: IPersonBreakpoint[];
  session?: ISessionStatus;
}

// What the agent may do to the debugger. The VS Code implementation is DebugControl. Every call reaches it
// through the AgentGateway, which checks consent, the control gate and blindness first.
export interface IAgentControl {
  listLaunchConfigs(): ILaunchConfigSummary[];
  output(): IOutputTail;
  pause(): Promise<{ isRequested: true }>;
  removeBreakpoint(id: string): IAgentBreakpoint;
  resume(): Promise<IResumeResult>;
  setBreakpoint(location: IBreakpointLocation): IAgentBreakpoint;
  startSession(name: string): Promise<{ name: string; sessionId: string }>;
  status(): IControlStatus;
  step(kind: StepKind): Promise<IResumeResult>;
  stopSession(): Promise<{ name: string }>;
}

export class ControlError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}

// The agent names files relative to the workspace root. Anything that escapes the root is refused.
export function resolveWorkspaceFile(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new ControlError(`'${relativePath}' must be a path relative to the workspace root.`);
  }
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ControlError(`'${relativePath}' is outside the workspace.`);
  }
  return resolved;
}

export function workspaceRelative(root: string, absolutePath: string): string {
  return toForwardSlashes(path.relative(root, absolutePath));
}

export function checkLine(line: number): void {
  if (!Number.isInteger(line) || line < 1) throw new ControlError(`Line ${line} is not a positive whole number.`);
}
