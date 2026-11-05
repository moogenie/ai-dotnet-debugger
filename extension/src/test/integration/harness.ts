import * as path from "node:path";
import * as vscode from "vscode";
import type { IAiDebuggerApi } from "../../extension";
import type { AnnotationController } from "../../annotations/annotation-controller";
import type { ControlLock } from "../../control/control-lock";
import type { AgentGateway } from "../../guardrails/agent-gateway";
import type { JournalController } from "../../journal/journal-controller";
import type { IMcpHostInfo } from "../../mcp/mcp-host";
import type { SessionEvent } from "../../session/session-events";
import type { SessionManager } from "../../session/session-manager";

const EXTENSION_ID = "moogenie.ai-dotnet-debugger";
const EVENT_TIMEOUT_MS = 120_000;
const START_ATTEMPTS = 24;
const START_RETRY_MS = 5_000;

export interface IHarness {
  annotations: AnnotationController;
  events: SessionEvent[];
  gateway: AgentGateway;
  journal: JournalController;
  lock: ControlLock;
  mcp: IMcpHostInfo;
  sessions: SessionManager;
}

let harness: IHarness | undefined;

export async function getHarness(): Promise<IHarness> {
  if (harness) return harness;
  const csharp = vscode.extensions.getExtension<{ initializationFinished?: () => Promise<void> }>(
    "ms-dotnettools.csharp",
  );
  const exports = await csharp?.activate();
  await exports?.initializationFinished?.();
  const extension = vscode.extensions.getExtension<IAiDebuggerApi>(EXTENSION_ID);
  if (!extension) throw new Error(`${EXTENSION_ID} is not loaded`);
  const api = await extension.activate();
  if (!api.sessions || !api.mcp || !api.journal || !api.lock || !api.annotations) {
    throw new Error("The session manager, MCP host and Journal are exported only in Test mode.");
  }
  const events: SessionEvent[] = [];
  api.sessions.onEvent((event) => events.push(event));
  harness = { annotations: api.annotations, events, gateway: api.gateway, journal: api.journal, lock: api.lock, mcp: api.mcp, sessions: api.sessions };
  return harness;
}

export function repoRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("The test instance must open the repository as its workspace.");
  return folder.uri.fsPath;
}

export function waitFor<K extends SessionEvent["kind"]>(
  events: readonly SessionEvent[],
  kind: K,
  fromIndex: number,
): Promise<Extract<SessionEvent, { kind: K }>> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    const poll = (): void => {
      const found = events.slice(fromIndex).find((event) => event.kind === kind);
      if (found) resolve(found as Extract<SessionEvent, { kind: K }>);
      else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${kind}`));
      else setTimeout(poll, 50);
    };
    poll();
  });
}

export function launchConfiguration(name: string): vscode.DebugConfiguration {
  const configurations = vscode.workspace
    .getConfiguration("launch", vscode.Uri.file(repoRoot()))
    .get<vscode.DebugConfiguration[]>("configurations", []);
  const found = configurations.find((configuration) => configuration.name === name);
  if (!found) throw new Error(`launch configuration not found: ${name}`);
  return { ...found, preLaunchTask: undefined };
}

export function setBreakpoint(file: string, line: number): void {
  const uri = vscode.Uri.file(path.join(repoRoot(), file));
  vscode.debug.addBreakpoints([
    new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line - 1, 0))),
  ]);
}

// On a fresh profile the C# extension downloads its debugger before it registers the coreclr adapter.
export async function startDebugging(configuration: vscode.DebugConfiguration): Promise<void> {
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    try {
      if (await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], configuration)) return;
      throw new Error(`startDebugging returned false for ${configuration.name}`);
    } catch (error) {
      if (!/debug adapter descriptor/i.test(String(error)) || attempt === START_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, START_RETRY_MS));
    }
  }
}

const STOP_TIMEOUT_MS = 15_000;

// Waits on VS Code's own terminate event, because agent-blind sessions never reach our tracker.
export async function stopAll(): Promise<void> {
  const session = vscode.debug.activeDebugSession;
  if (session) {
    const terminated = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
      const listener = vscode.debug.onDidTerminateDebugSession((ended) => {
        if (ended.id !== session.id) return;
        clearTimeout(timer);
        listener.dispose();
        resolve();
      });
    });
    await vscode.debug.stopDebugging(session);
    await terminated;
  }
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
}

type WarningReply = string | undefined;
const originalShowWarning = vscode.window.showWarningMessage;

export function replyToWarnings(reply: WarningReply): void {
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (): Promise<WarningReply> =>
    Promise.resolve(reply);
}

export function restoreWarnings(): void {
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = originalShowWarning;
}

export async function enable(): Promise<void> {
  replyToWarnings("Enable for this workspace");
  try {
    await vscode.commands.executeCommand("aiDebugger.enableForWorkspace");
  } finally {
    restoreWarnings();
  }
}

// Watch mode with the agent holding the lock, for tests about other features. Tests that send DAP requests
// straight through customRequest look like the person to the lock, so each test file sets this up again.
export async function agentDrives(): Promise<void> {
  await vscode.commands.executeCommand("aiDebugger.setControlMode", "watch");
  await vscode.commands.executeCommand("aiDebugger.handBack");
}
