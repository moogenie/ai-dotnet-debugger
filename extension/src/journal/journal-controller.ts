import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { z } from "zod";
import type { AnnotationStore } from "../annotations/annotation-store";
import type { ControlLock, ControlRecord } from "../control/control-lock";
import type { IConsentCheck } from "../guardrails/agent-gateway";
import type { EventInbox } from "../mcp/event-inbox";
import type { SessionEvent } from "../session/session-events";
import type { ISnapshotFrame } from "../session/snapshot.types";
import { JournalModel, type IAskedQuestion } from "./journal-model";
import {
  MAX_QUESTION_CHARS,
  type ControlMode,
  type HostMessage,
  type IJournalState,
  type IProposalView,
  type IStopLocation,
} from "./webview/journal-protocol";

export const JOURNAL_VIEW_ID = "aiDebugger.journal";
const NONCE_BYTES = 16;
const LOCATION_ATTEMPTS = 3;
const LOCATION_RETRY_MS = 300;

const APPROVE = "Approve";
const REJECT = "Reject";
const MODES: { description: string; label: string; mode: ControlMode }[] = [
  { description: "The agent proposes each change and you approve it. Starting a session needs no approval. The default.", label: "Pair", mode: "pair" },
  { description: "The agent drives without asking. You can still take control at any time.", label: "Watch", mode: "watch" },
  { description: "The agent only reads and narrates. Every control tool is refused.", label: "Observe", mode: "observe" },
];

const webviewMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ text: z.string(), type: z.literal("ask") }),
  z.object({ type: z.literal("clear") }),
  z.object({ decision: z.enum(["approved", "rejected"]), proposalId: z.string(), type: z.literal("decide") }),
  z.object({ mode: z.enum(["observe", "pair", "watch"]), type: z.literal("mode") }),
  z.object({ type: z.literal("take") }),
  z.object({ type: z.literal("handBack") }),
  z.object({ annotationId: z.string(), type: z.literal("dismiss") }),
]);

export interface IJournalSessions {
  onEvent(listener: (event: SessionEvent) => void): { dispose(): void };
  topFrame(stopId: number): Promise<ISnapshotFrame | undefined>;
}

export class QuestionRefusedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "QuestionRefusedError";
  }
}

// Owns the Debug Journal: the timeline model, the webview in the Run and Debug view, and the person's questions.
// The webview keeps no state. Each change sends it the whole state again, so a reload shows the same truth.
export class JournalController implements vscode.WebviewViewProvider, vscode.Disposable {
  public readonly model = new JournalModel();
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly inbox: EventInbox,
    private readonly consent: IConsentCheck,
    private readonly sessions: IJournalSessions,
    private readonly lock: ControlLock,
    annotations: AnnotationStore,
  ) {
    this.disposables.push(
      annotations.onDidChange((change) => this.model.recordAnnotation(change)),
      lock.onDidChange((record) => this.onControlChange(record)),
      sessions.onEvent((event) => this.onSessionEvent(event)),
      inbox.listen({
        onDelivered: (item) => {
          if (item.kind === "question" && item.questionId !== undefined) this.model.markDelivered(item.questionId);
        },
        onListeningChanged: () => this.post(),
      }),
      this.model.onDidChange(() => this.post()),
    );
  }

  // True once VS Code has created the webview and it is on screen.
  public get isViewVisible(): boolean {
    return this.view?.visible ?? false;
  }

  public state(): IJournalState {
    return {
      ...this.model.snapshot(),
      control: this.lock.describe(),
      isAgentListening: this.inbox.isListening,
      isEnabled: this.consent.isGranted(),
    };
  }

  // Sends the person's question to the agent with the stop and location the Journal shows now.
  public ask(question: string): IAskedQuestion {
    const text = question.trim();
    if (!text) throw new QuestionRefusedError("The question is empty.");
    if (text.length > MAX_QUESTION_CHARS) throw new QuestionRefusedError(`The question is longer than ${MAX_QUESTION_CHARS} characters.`);
    if (!this.consent.isGranted()) {
      throw new QuestionRefusedError("AI Debugger is not enabled for this workspace, so no agent can read the question.");
    }
    const asked = this.model.addQuestion(text);
    this.inbox.push({ kind: "question", location: asked.location, questionId: asked.questionId, stopId: asked.stopId, text });
    return asked;
  }

  // Consent changes outside the Journal, so the enable command calls this.
  public refresh(): void {
    this.post();
  }

  public registerCommands(): vscode.Disposable[] {
    return [
      vscode.window.registerWebviewViewProvider(JOURNAL_VIEW_ID, this),
      vscode.commands.registerCommand("aiDebugger.openJournal", () => vscode.commands.executeCommand(`${JOURNAL_VIEW_ID}.focus`)),
      vscode.commands.registerCommand("aiDebugger.askAgent", (question?: string) => this.askFromCommand(question)),
      vscode.commands.registerCommand("aiDebugger.setControlMode", (mode?: ControlMode) => this.setModeFromCommand(mode)),
      vscode.commands.registerCommand("aiDebugger.takeControl", () => this.lock.takeControl("the Take control button")),
      vscode.commands.registerCommand("aiDebugger.handBack", () => this.lock.handBack()),
      vscode.commands.registerCommand("aiDebugger.decideProposal", (proposalId: string, decision: "approved" | "rejected") =>
        this.lock.decide(proposalId, decision),
      ),
    ];
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const scripts = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const styles = vscode.Uri.joinPath(this.extensionUri, "resources", "journal");
    view.webview.options = { enableCommandUris: false, enableScripts: true, localResourceRoots: [scripts, styles] };
    view.webview.html = journalHtml(
      view.webview.cspSource,
      view.webview.asWebviewUri(vscode.Uri.joinPath(scripts, "journal-client.js")).toString(),
      view.webview.asWebviewUri(vscode.Uri.joinPath(styles, "journal.css")).toString(),
    );
    this.disposables.push(
      view.webview.onDidReceiveMessage((message: unknown) => this.onWebviewMessage(message)),
      view.onDidChangeVisibility(() => this.post()),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
      }),
    );
  }

  public dispose(): void {
    this.disposables.forEach((disposable) => void disposable.dispose());
  }

  private onSessionEvent(event: SessionEvent): void {
    this.model.onSessionEvent(event);
    if (event.kind === "stopped") void this.findLocation(event.stopId);
  }

  // When the agent steps at once, vsdbg can fail the stack request before the resume reaches the extension.
  // A short retry lets the resume arrive first, so the Journal says the process resumed rather than that
  // the debugger had no location. Only a stop that stays current and still fails is marked unavailable.
  private async findLocation(stopId: number): Promise<void> {
    for (let attempt = 1; attempt <= LOCATION_ATTEMPTS; attempt++) {
      const frame = await this.sessions.topFrame(stopId).catch(() => undefined);
      if (frame) {
        this.model.setLocation(stopId, toLocation(frame));
        return;
      }
      if (attempt < LOCATION_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, LOCATION_RETRY_MS));
    }
    this.model.setLocation(stopId, undefined);
  }

  private onWebviewMessage(raw: unknown): void {
    const parsed = webviewMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "ready") this.post();
    else if (message.type === "clear") this.model.clear();
    else if (message.type === "decide") this.decide(message.proposalId, message.decision);
    else if (message.type === "mode") this.lock.setMode(message.mode);
    else if (message.type === "take") this.lock.takeControl("the Take control button");
    else if (message.type === "handBack") this.lock.handBack();
    else if (message.type === "dismiss") void vscode.commands.executeCommand("aiDebugger.dismissAnnotation", message.annotationId);
    else {
      try {
        this.ask(message.text);
      } catch (error) {
        this.send({ message: error instanceof Error ? error.message : String(error), type: "error" });
      }
    }
  }

  private onControlChange(record: ControlRecord | undefined): void {
    if (!record) {
      this.post();
      return;
    }
    this.model.recordControl(record);
    // A notification cannot be closed from code, so it would outlive a decision made in the Journal.
    // It appears only when the Journal is not on screen to show the Approve and Reject buttons.
    if (record.kind === "proposal" && record.proposal.status === "pending" && !this.isViewVisible) {
      void this.notifyProposal(record.proposal);
    }
  }

  // The Journal may be hidden, so a proposal then shows as a notification. Both decide the same proposal.
  private async notifyProposal(proposal: IProposalView): Promise<void> {
    const where = proposal.stopId === undefined ? "" : ` at stop ${proposal.stopId}`;
    const choice = await vscode.window.showInformationMessage(
      `The agent wants to run ${describeProposal(proposal)}${where}.`,
      APPROVE,
      REJECT,
    );
    if (choice) this.decide(proposal.id, choice === APPROVE ? "approved" : "rejected");
  }

  private decide(proposalId: string, decision: "approved" | "rejected"): void {
    if (!this.lock.decide(proposalId, decision)) {
      this.send({ message: `Proposal ${proposalId} is no longer waiting, so nothing changed.`, type: "error" });
    }
  }

  private async setModeFromCommand(mode?: ControlMode): Promise<void> {
    const chosen =
      mode ??
      (
        await vscode.window.showQuickPick(
          MODES.map((option) => ({ ...option, picked: option.mode === this.lock.mode })),
          { placeHolder: `How much may the agent drive? Now: ${this.lock.mode}.` },
        )
      )?.mode;
    if (chosen) this.lock.setMode(chosen);
  }

  private async askFromCommand(question?: string): Promise<void> {
    const text = question ?? (await vscode.window.showInputBox({ prompt: "Ask the agent about the current stop" }));
    if (!text?.trim()) return;
    const isListening = this.inbox.isListening;
    try {
      this.ask(text);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!isListening) {
      void vscode.window.showInformationMessage(
        "The agent is not waiting for events right now. It sees the question only at its next wait_for_event call. To be sure it reads it, ask in the Claude Code chat.",
      );
    }
  }

  private post(): void {
    if (this.view?.visible) this.send({ state: this.state(), type: "state" });
  }

  private send(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }
}

export function describeProposal(proposal: Pick<IProposalView, "summary" | "tool">): string {
  return proposal.summary ? `${proposal.tool} (${proposal.summary})` : proposal.tool;
}

function toLocation(frame: ISnapshotFrame): IStopLocation {
  return { line: frame.line, name: frame.name, source: frame.source };
}

function journalHtml(cspSource: string, scriptUri: string, styleUri: string): string {
  const nonce = randomBytes(NONCE_BYTES).toString("base64");
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "font-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>AI Debug Journal</title>
</head>
<body>
<header id="status" aria-live="polite"></header>
<main id="timeline" aria-label="Timeline"></main>
<form id="ask">
<label for="question">Ask the agent about the current stop</label>
<textarea id="question" rows="3" maxlength="${MAX_QUESTION_CHARS}"></textarea>
<p id="ask-hint"></p>
<div class="actions"><button type="submit" id="send">Ask</button><button type="button" id="clear" class="secondary">Clear timeline</button></div>
</form>
<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
