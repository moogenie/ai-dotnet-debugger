// Runs inside the Debug Journal webview. It renders only the state the extension sends and keeps none of its own.
// Every value goes into the page as text, never as HTML: narration is model output and must not become markup.
import type {
  ControlMode,
  IAnnotationItem,
  HostMessage,
  IControlItem,
  IJournalState,
  IProposalItem,
  IStopItem,
  IStopLocation,
  JournalItem,
  ProposalStatus,
  WebviewMessage,
} from "./journal-protocol";

interface IVsCodeApi {
  postMessage(message: WebviewMessage): void;
}

declare function acquireVsCodeApi(): IVsCodeApi;

const vscode = acquireVsCodeApi();

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`The Journal page has no #${id}.`);
  return element as T;
}

const status = byId<HTMLElement>("status");
const timeline = byId<HTMLElement>("timeline");
const form = byId<HTMLFormElement>("ask");
const question = byId<HTMLTextAreaElement>("question");
const hint = byId<HTMLParagraphElement>("ask-hint");
const clear = byId<HTMLButtonElement>("clear");

function element(tag: string, className: string, text?: string): HTMLElement {
  const created = document.createElement(tag);
  created.className = className;
  if (text !== undefined) created.textContent = text;
  return created;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function locationText(location: IStopLocation | undefined): string {
  if (!location) return "";
  const where = location.source ? `${location.source}:${location.line}` : `line ${location.line}, no source file`;
  return `${location.name} at ${where}`;
}

function stopLocation(stop: IStopItem): string {
  if (stop.locationState === "pending") return "Asking the debugger for the location...";
  if (stop.locationState === "unavailable") return "The debugger did not report a location.";
  if (stop.locationState === "resumed") return "The process resumed before the debugger reported a location.";
  return locationText(stop.location);
}

const MODE_TEXT: Record<ControlMode, { detail: string; label: string }> = {
  observe: { detail: "The agent only reads and narrates. It cannot change the debugger.", label: "Observe" },
  pair: { detail: "The agent proposes each change. Nothing runs until you approve it, except starting a session.", label: "Pair" },
  watch: { detail: "The agent drives without asking. Any debug control you press takes control back.", label: "Watch" },
};

const STATUS_TEXT: Record<ProposalStatus, string> = {
  approved: "Approved",
  cancelled: "Cancelled",
  expired: "Expired",
  pending: "Waiting for you",
  rejected: "Rejected",
};

function button(label: string, className: string, message: WebviewMessage): HTMLButtonElement {
  const created = document.createElement("button");
  created.type = "button";
  created.className = className;
  created.textContent = label;
  created.addEventListener("click", () => vscode.postMessage(message));
  return created;
}

function proposalText(item: IProposalItem): string {
  const { proposal } = item;
  const what = proposal.summary ? `${proposal.tool} (${proposal.summary})` : proposal.tool;
  return proposal.stopId === undefined ? what : `${what} at stop ${proposal.stopId}`;
}

function renderProposal(item: IProposalItem): HTMLElement {
  const { proposal } = item;
  const card = element("article", `item proposal ${proposal.status}`);
  card.append(
    element("p", "meta", `The agent proposed, ${time(proposal.at)}`),
    element("p", "proposal-text", proposalText(item)),
  );
  if (proposal.status === "pending") {
    const actions = element("div", "actions");
    actions.append(
      button("Approve", "", { decision: "approved", proposalId: proposal.id, type: "decide" }),
      button("Reject", "secondary", { decision: "rejected", proposalId: proposal.id, type: "decide" }),
    );
    card.append(element("p", "meta waiting", STATUS_TEXT.pending), actions);
  } else {
    const when = proposal.decidedAt ? ` at ${time(proposal.decidedAt)}` : "";
    const why = proposal.reason ? `: ${proposal.reason}` : "";
    card.append(element("p", "meta", `${STATUS_TEXT[proposal.status]}${when}${why}.`));
  }
  return card;
}

function renderAnnotation(item: IAnnotationItem): HTMLElement {
  const { annotation } = item;
  const card = element("article", item.clearedAt ? "item annotation cleared" : "item annotation");
  card.append(
    element("p", "meta", `The agent pinned a note, ${time(item.at)}`),
    element("p", "location", `${annotation.path}:${annotation.line}`),
    element("blockquote", "narration", annotation.text),
  );
  if (item.clearedAt) {
    card.append(element("p", "meta", `Removed at ${time(item.clearedAt)}: ${item.clearedBecause ?? "no reason given"}.`));
  } else {
    card.append(button("Dismiss", "secondary", { annotationId: annotation.id, type: "dismiss" }));
  }
  return card;
}

function renderControlItem(item: IControlItem): HTMLElement {
  if (item.change === "taken") return element("p", "item control-change", `You took control (${item.cause ?? "a debug action"}), ${time(item.at)}.`);
  if (item.change === "handed_back") return element("p", "item control-change", `You handed control back to the agent, ${time(item.at)}.`);
  const mode = item.mode ? MODE_TEXT[item.mode].label : "another";
  return element("p", "item control-change", `Mode changed to ${mode}, ${time(item.at)}.`);
}

function renderControl(state: IJournalState): HTMLElement {
  const panel = element("section", "control-panel");
  const { holder, mode } = state.control;
  const modes = element("div", "modes");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Control mode");
  for (const option of ["pair", "watch", "observe"] as const) {
    const choice = button(MODE_TEXT[option].label, option === mode ? "mode selected" : "mode secondary", { mode: option, type: "mode" });
    choice.setAttribute("aria-pressed", String(option === mode));
    modes.append(choice);
  }
  panel.append(modes, element("p", "control", MODE_TEXT[mode].detail));
  if (holder === "person") {
    panel.append(
      element("p", "holder person", "You have control. The agent's control tools are refused until you hand back."),
      button("Hand back to the agent", "", { type: "handBack" }),
    );
  } else {
    panel.append(element("p", "holder agent", "The agent holds the lock."), button("Take control", "secondary", { type: "take" }));
  }
  return panel;
}

// Names the resume the debugger reported. It says nothing about who asked for it; the control items show that.
const RESUME_NAMES: Record<string, string> = {
  continue: "continue",
  "continued-event": "the debugger's continued event",
  next: "step over",
  stepIn: "step into",
  stepOut: "step out",
};

function renderStop(stop: IStopItem, isCurrent: boolean): HTMLElement {
  const card = element("article", isCurrent ? "item stop current" : "item stop");
  const heading = element("h3", "title", `Stop ${stop.stopId}: ${stop.reason}${isCurrent ? " (current)" : ""}`);
  card.append(heading, element("p", "meta", time(stop.at)), element("p", stop.locationState === "reported" ? "location" : "meta", stopLocation(stop)));
  if (stop.text) card.append(element("p", "detail", stop.text));
  if (stop.narrations.length === 0) {
    card.append(element("p", "empty", "The agent has not narrated this stop."));
  }
  for (const narration of stop.narrations) {
    const note = element("blockquote", "narration", narration.text);
    note.title = `Agent, ${time(narration.at)}`;
    card.append(note);
  }
  if (stop.resumedBy) card.append(element("p", "meta", `Resumed: ${RESUME_NAMES[stop.resumedBy] ?? stop.resumedBy}.`));
  return card;
}

function renderItem(item: JournalItem, state: IJournalState): HTMLElement {
  switch (item.kind) {
    case "session":
      return element("h2", "item session", `Session started: ${item.name} (${time(item.at)})`);
    case "stop":
      return renderStop(item, item.stopId === state.currentStopId);
    case "note": {
      const card = element("article", "item note");
      card.append(element("p", "meta", `Agent note, ${time(item.at)}`), element("blockquote", "narration", item.text));
      return card;
    }
    case "question": {
      const card = element("article", "item question");
      const about = item.stopId === undefined ? "not at a stop" : `at stop ${item.stopId}`;
      const answered = (item.answers ?? []).length > 0 ? " (answered)" : "";
      card.append(element("p", "meta", `You asked ${about}, ${time(item.at)}${answered}`), element("p", "question-text", item.text));
      if (item.location) card.append(element("p", "location", locationText(item.location)));
      const answers = item.answers ?? [];
      for (const answer of answers) {
        card.append(element("p", "meta", `The agent answered, ${time(answer.at)}`), element("blockquote", "narration answer", answer.text));
      }
      if (answers.length === 0) {
        const delivery = item.deliveredAt
          ? `Sent to the agent at ${time(item.deliveredAt)}. Not answered yet.`
          : "Waiting: the agent reads it at its next wait_for_event call.";
        card.append(element("p", item.deliveredAt ? "meta" : "meta waiting", delivery));
      }
      return card;
    }
    case "proposal":
      return renderProposal(item);
    case "annotation":
      return renderAnnotation(item);
    case "control":
      return renderControlItem(item);
    case "exited":
      return element("p", "item exited", `Session ended${item.exitCode === undefined ? "" : ` with exit code ${item.exitCode}`} (${time(item.at)}).`);
    default:
      return element("p", "item", "");
  }
}

function render(state: IJournalState): void {
  status.replaceChildren(
    renderControl(state),
    element(
      "p",
      state.isAgentListening ? "listening yes" : "listening no",
      state.isAgentListening ? "The agent is waiting for events." : "The agent is not waiting for events right now.",
    ),
  );
  const children: HTMLElement[] = [];
  if (state.itemsOmitted > 0) children.push(element("p", "meta", `${state.itemsOmitted} earlier items are not shown.`));
  for (const item of state.items) children.push(renderItem(item, state));
  if (state.items.length === 0) children.push(element("p", "empty", "Nothing yet. Stops and the agent's notes appear here."));
  timeline.replaceChildren(...children);

  if (!state.isEnabled) {
    hint.textContent = "AI Debugger is not enabled for this workspace. Run 'AI Debugger: Enable for this workspace' first.";
  } else if (!state.isAgentListening) {
    hint.textContent = "The agent is not listening now. It reads your question at its next wait_for_event call. To be sure, ask in the Claude Code chat.";
  } else {
    hint.textContent = state.currentStopId === undefined ? "Not stopped: the question carries no stop." : `Your question carries stop ${state.currentStopId}.`;
  }
  question.disabled = !state.isEnabled;
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === "state") render(message.state);
  else hint.textContent = message.message;
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = question.value.trim();
  if (!text) return;
  vscode.postMessage({ text, type: "ask" });
  question.value = "";
});

clear.addEventListener("click", () => vscode.postMessage({ type: "clear" }));

vscode.postMessage({ type: "ready" });
