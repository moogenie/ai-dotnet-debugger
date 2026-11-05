import { statSync } from "node:fs";
import * as vscode from "vscode";
import { assessSession } from "../guardrails/session-eligibility";
import { threadsResponseSchema } from "../session/dap-contracts";
import { NoSessionError, NoStoppedSessionError, type SessionManager } from "../session/session-manager";
import type { IOutputTail } from "../session/session-tracker";
import {
  checkLine,
  ControlError,
  resolveWorkspaceFile,
  STEP_COMMANDS,
  workspaceRelative,
  type IAgentBreakpoint,
  type IAgentControl,
  type IBreakpointLocation,
  type IControlStatus,
  type ILaunchConfigSummary,
  type IPersonBreakpoint,
  type IResumeResult,
  type StepKind,
} from "./agent-control";

interface IOwnedBreakpoint {
  breakpoint: vscode.SourceBreakpoint;
  info: IAgentBreakpoint;
}

// Carries out agent control requests against VS Code. It keeps a registry of the breakpoints the agent set,
// so the agent can never remove one of the person's. Agent breakpoints go when the followed session ends.
export class DebugControl implements IAgentControl, vscode.Disposable {
  private readonly owned = new Map<string, IOwnedBreakpoint>();
  private readonly disposables: vscode.Disposable[] = [];
  private nextId = 0;

  public constructor(private readonly sessions: SessionManager) {
    const subscription = sessions.onEvent((event) => {
      if (event.kind === "terminated") this.removeAllAgentBreakpoints();
    });
    this.disposables.push(
      { dispose: (): void => subscription.dispose() },
      vscode.debug.onDidChangeBreakpoints(({ removed }) => {
        for (const [id, owned] of this.owned) {
          if (removed.includes(owned.breakpoint)) this.owned.delete(id);
        }
      }),
    );
  }

  public listLaunchConfigs(): ILaunchConfigSummary[] {
    return this.launchConfigurations().map((configuration) => {
      const { isAgentVisible, reasons } = assessSession(configuration);
      return {
        isAgentVisible,
        name: configuration.name,
        reasons,
        request: String(configuration.request),
        type: String(configuration.type),
      };
    });
  }

  public async startSession(name: string): Promise<{ name: string; sessionId: string }> {
    const running = this.followedSession();
    if (running) throw new ControlError(`The session '${running.name}' is already running. Stop it first.`);
    const configuration = this.launchConfigurations().find((candidate) => candidate.name === name);
    if (!configuration) {
      const names = this.launchConfigurations().map((candidate) => `'${candidate.name}'`);
      throw new ControlError(`There is no launch configuration named '${name}'. Choose one of ${names.join(", ")}.`);
    }
    const { reasons } = assessSession(configuration);
    if (reasons.length > 0) throw new ControlError(`The agent may not start '${name}' because ${reasons.join("; ")}.`);
    // Passing the name, not the object, keeps the person's launch.json authoritative, including preLaunchTask.
    if (!(await vscode.debug.startDebugging(this.folder(), name))) {
      throw new ControlError(`VS Code did not start '${name}'. The build or the launch failed.`);
    }
    // Read again: the tracker factory has run during startDebugging.
    const followed = this.followedSession();
    if (!followed) throw new ControlError(`'${name}' started, but the extension is not following it.`);
    return { name: followed.name, sessionId: followed.id };
  }

  public async stopSession(): Promise<{ name: string }> {
    const session = this.sessions.session;
    if (!session) throw new NoSessionError();
    await vscode.debug.stopDebugging(session);
    return { name: session.name };
  }

  public setBreakpoint(location: IBreakpointLocation): IAgentBreakpoint {
    checkLine(location.line);
    const root = this.folder().uri.fsPath;
    const file = resolveWorkspaceFile(root, location.path);
    if (!isFile(file)) throw new ControlError(`'${location.path}' is not a file in the workspace.`);
    const uri = vscode.Uri.file(file);
    const existing = this.sourceBreakpoints().find(
      (breakpoint) => breakpoint.location.uri.toString() === uri.toString() && breakpoint.location.range.start.line === location.line - 1,
    );
    if (existing) {
      const mine = [...this.owned.values()].find((owned) => owned.breakpoint === existing);
      if (mine) return mine.info;
      throw new ControlError(`The person already has a breakpoint at ${location.path}:${location.line}.`);
    }
    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(location.line - 1, 0)));
    vscode.debug.addBreakpoints([breakpoint]);
    this.nextId++;
    const info: IAgentBreakpoint = { id: `bp${this.nextId}`, line: location.line, path: workspaceRelative(root, file) };
    this.owned.set(info.id, { breakpoint, info });
    return info;
  }

  public removeBreakpoint(id: string): IAgentBreakpoint {
    const owned = this.owned.get(id);
    if (!owned) {
      throw new ControlError(`'${id}' is not a breakpoint the agent set. The agent cannot remove the person's breakpoints.`);
    }
    vscode.debug.removeBreakpoints([owned.breakpoint]);
    this.owned.delete(id);
    return owned.info;
  }

  public async resume(): Promise<IResumeResult> {
    return this.resumeWith("continue");
  }

  public async step(kind: StepKind): Promise<IResumeResult> {
    return this.resumeWith(STEP_COMMANDS[kind]);
  }

  public async pause(): Promise<{ isRequested: true }> {
    if (!this.sessions.session) throw new NoSessionError();
    if (this.sessions.currentStop) throw new ControlError("The process is already stopped.");
    await this.sessions.request("pause", { threadId: await this.firstThreadId() });
    return { isRequested: true };
  }

  public status(): IControlStatus {
    const session = this.sessions.session;
    const stop = this.sessions.currentStop;
    return {
      agentBreakpoints: [...this.owned.values()].map((owned) => owned.info),
      personBreakpoints: this.personBreakpoints(),
      session: session && {
        id: session.id,
        name: session.name,
        reason: stop?.reason,
        state: stop ? "stopped" : "running",
        stopId: stop?.stopId,
      },
    };
  }

  public output(): IOutputTail {
    return this.sessions.outputTail();
  }

  public dispose(): void {
    this.removeAllAgentBreakpoints();
    this.disposables.forEach((disposable) => void disposable.dispose());
  }

  private followedSession(): vscode.DebugSession | undefined {
    return this.sessions.session;
  }

  private async resumeWith(command: string): Promise<IResumeResult> {
    const stop = this.sessions.currentStop;
    if (!stop) throw new NoStoppedSessionError();
    await this.sessions.request(command, { threadId: stop.threadId ?? (await this.firstThreadId()) });
    return { command, resumedFromStopId: stop.stopId };
  }

  private async firstThreadId(): Promise<number> {
    const parsed = threadsResponseSchema.safeParse(await this.sessions.request("threads", {}));
    const first = parsed.success ? parsed.data.threads[0] : undefined;
    if (!first) throw new ControlError("The debug adapter reported no threads.");
    return first.id;
  }

  private removeAllAgentBreakpoints(): void {
    vscode.debug.removeBreakpoints([...this.owned.values()].map((owned) => owned.breakpoint));
    this.owned.clear();
  }

  private personBreakpoints(): IPersonBreakpoint[] {
    const root = this.folder().uri.fsPath;
    const mine = new Set([...this.owned.values()].map((owned) => owned.breakpoint));
    return this.sourceBreakpoints()
      .filter((breakpoint) => !mine.has(breakpoint))
      .map((breakpoint) => ({
        isEnabled: breakpoint.enabled,
        line: breakpoint.location.range.start.line + 1,
        path: workspaceRelative(root, breakpoint.location.uri.fsPath),
      }));
  }

  private sourceBreakpoints(): vscode.SourceBreakpoint[] {
    return vscode.debug.breakpoints.filter((breakpoint) => breakpoint instanceof vscode.SourceBreakpoint);
  }

  private launchConfigurations(): vscode.DebugConfiguration[] {
    return vscode.workspace
      .getConfiguration("launch", this.folder().uri)
      .get<vscode.DebugConfiguration[]>("configurations", [])
      .filter((configuration) => typeof configuration.name === "string");
  }

  private folder(): vscode.WorkspaceFolder {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new ControlError("Open the project folder in VS Code first.");
    return folder;
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
