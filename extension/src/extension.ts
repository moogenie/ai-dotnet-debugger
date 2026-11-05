import * as vscode from "vscode";
import { AnnotationController } from "./annotations/annotation-controller";
import { ControlLock } from "./control/control-lock";
import { DebugControl } from "./control/debug-control";
import { AgentGateway } from "./guardrails/agent-gateway";
import {
  ModalApprover,
  createAuditLog,
  createConsent,
  currentRedactor,
  registerGuardrailCommands,
} from "./guardrails/vscode-guardrails";
import { JournalController } from "./journal/journal-controller";
import { EventInbox } from "./mcp/event-inbox";
import { McpHost, type IMcpHostInfo } from "./mcp/mcp-host";
import { SessionManager } from "./session/session-manager";
import { SkillInstaller } from "./skill/skill-installer";

export interface IAiDebuggerApi {
  // Present only in Test mode, like the members below.
  annotations?: AnnotationController;
  gateway: AgentGateway;
  // Present only in Test mode. In normal use these would be a way around the guardrails.
  journal?: JournalController;
  lock?: ControlLock;
  mcp?: IMcpHostInfo;
  sessions?: SessionManager;
}

let activeHost: McpHost | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<IAiDebuggerApi> {
  const log = vscode.window.createOutputChannel("AI Debugger");
  const sessions = new SessionManager();
  const control = new DebugControl(sessions);
  const inbox = new EventInbox();
  const inboxFeed = sessions.onEvent((event) => inbox.fromSession(event));
  // Pair is the default on every activation. The mode is not stored, so Watch never carries over by surprise.
  const lock = new ControlLock({
    currentStopId: (): number | undefined => sessions.currentStop?.stopId,
    notifyAgent: (event): void => inbox.push(event),
  });
  const lockFeed = sessions.onEvent((event) => {
    if (event.kind === "person-control") lock.takeControl(`the person's ${event.command} request`);
    else if (event.kind === "started" || event.kind === "stopped" || event.kind === "continued" || event.kind === "terminated") {
      lock.onStopChanged();
    }
  });
  const audit = createAuditLog(context);
  const consent = createConsent(context);
  const annotations = new AnnotationController(sessions);
  const journal = new JournalController(context.extensionUri, inbox, consent, sessions, lock, annotations.store);
  const gateway = new AgentGateway({
    annotations,
    approver: new ModalApprover(),
    audit,
    consent,
    control,
    events: inbox,
    gate: lock,
    journal: journal.model,
    redactor: currentRedactor,
    sessions,
  });
  const host = new McpHost(context, gateway, inbox, consent, log);
  activeHost = host;
  context.subscriptions.push(
    log,
    sessions,
    control,
    { dispose: (): void => inboxFeed.dispose() },
    { dispose: (): void => lockFeed.dispose() },
    lock,
    host,
    journal,
    annotations,
    ...annotations.registerCommands(),
    ...new SkillInstaller(context.extensionUri).registerCommands(),
    ...host.registerCommands(),
    ...journal.registerCommands(),
    ...registerGuardrailCommands(consent, audit, async () => {
      await host.syncWithConsent();
      journal.refresh();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void host.syncWithConsent()),
  );
  await host.syncWithConsent();
  return context.extensionMode === vscode.ExtensionMode.Test ? { annotations, gateway, journal, lock, mcp: host, sessions } : { gateway };
}

// VS Code waits for this promise before the extension host exits, but not for async work started by dispose().
// Without the wait, the host can exit before the token is deleted from the credential store.
export async function deactivate(): Promise<void> {
  await activeHost?.stop();
  activeHost = undefined;
}
