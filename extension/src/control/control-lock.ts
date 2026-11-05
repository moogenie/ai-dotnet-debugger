import { ControlRefusedError, type IControlGate } from "../guardrails/agent-gateway";
import type {
  ControlHolder,
  ControlMode,
  IControlState,
  IProposalView,
  ProposalDecision,
} from "../journal/webview/journal-protocol";

export const PROPOSAL_EXPIRY_MS = 300_000;
// Below the 150-second client timeout the registration sets, so the tool call returns before Claude Code gives up.
export const PROPOSAL_WAIT_MS = 100_000;
const KEPT_PROPOSALS = 50;
// Tools that run without a proposal in Pair mode. The owner chose on 21 Oct 2026 that starting a session needs
// no approval; the decision record lists it as a session tool, not a control tool. Observe mode and the
// person holding the lock still refuse it, and every step after the start still needs approval.
const PAIR_WITHOUT_APPROVAL = new Set(["start_session"]);

export class ProposalPendingError extends ControlRefusedError {
  public constructor(public readonly proposalId: string) {
    super(
      `Proposal ${proposalId} still waits for the person. Call wait_for_event: a proposal_decided event follows. ` +
        "If it is approved, call the same tool again with the same arguments while the same stop is current.",
    );
    this.name = "ProposalPendingError";
  }
}

// What the agent hears about control. These go to the event inbox.
export type ControlEvent =
  | { cause: string; kind: "took_control" }
  | { kind: "handed_back" }
  | { decision: ProposalDecision; kind: "proposal_decided"; proposalId: string; reason?: string; tool: string };

// What the person's Journal records about control.
export type ControlRecord =
  | { kind: "proposal"; proposal: IProposalView }
  | { cause: string; kind: "taken" }
  | { kind: "handed_back" }
  | { kind: "mode"; mode: ControlMode };

interface IProposal extends IProposalView {
  expiresAt: number;
  isUsed: boolean;
  key: string;
  timer: ReturnType<typeof setTimeout>;
  waiters: Set<(proposal: IProposal) => void>;
}

export interface IControlLockOptions {
  currentStopId: () => number | undefined;
  notifyAgent: (event: ControlEvent) => void;
  now?: () => number;
  waitMs?: number;
}

const DECISION_WORDS: Record<ProposalDecision, string> = {
  approved: "approved",
  cancelled: "cancelled",
  expired: "expired after 5 minutes without a decision",
  rejected: "rejected",
};

// The control lock: one side steps at a time, in the Pair, Watch or Observe mode. The extension enforces it,
// whatever the agent's own permission settings say. Holds no VS Code types, so unit tests drive it directly.
export class ControlLock implements IControlGate {
  private modeValue: ControlMode = "pair";
  private holderValue: ControlHolder = "agent";
  private readonly proposals: IProposal[] = [];
  private readonly changeListeners = new Set<(record?: ControlRecord) => void>();
  private nextProposal = 0;
  private readonly now: () => number;
  private readonly waitMs: number;

  public constructor(private readonly options: IControlLockOptions) {
    this.now = options.now ?? Date.now;
    this.waitMs = options.waitMs ?? PROPOSAL_WAIT_MS;
  }

  public get mode(): ControlMode {
    return this.modeValue;
  }

  public get holder(): ControlHolder {
    return this.holderValue;
  }

  // The listener gets a record when something belongs in the Journal's timeline, and nothing for other changes.
  public onDidChange(listener: (record?: ControlRecord) => void): { dispose(): void } {
    this.changeListeners.add(listener);
    return { dispose: (): void => void this.changeListeners.delete(listener) };
  }

  public describe(): IControlState {
    return {
      holder: this.holderValue,
      mode: this.modeValue,
      pending: this.proposals.filter((proposal) => proposal.status === "pending").map(toView),
    };
  }

  // Called by the AgentGateway before every tool that changes the debugger. It throws to refuse.
  public async authorise(tool: string, summary: string): Promise<void> {
    if (this.modeValue === "observe") {
      throw new ControlRefusedError("Observe mode: the person has set the agent to read only. Use the read tools and narrate.");
    }
    if (this.holderValue === "person") {
      throw new ControlRefusedError(
        "The person has control. Control tools are refused until they hand it back; a handed_back event follows. Keep reading and narrating.",
      );
    }
    if (this.modeValue === "watch" || PAIR_WITHOUT_APPROVAL.has(tool)) return;

    const stopId = this.options.currentStopId();
    const key = `${tool}\n${summary}\n${stopId ?? "none"}`;
    const approved = this.proposals.find(
      (proposal) => proposal.key === key && proposal.status === "approved" && !proposal.isUsed && proposal.expiresAt > this.now(),
    );
    if (approved) {
      approved.isUsed = true;
      return;
    }
    const proposal = this.proposals.find((candidate) => candidate.key === key && candidate.status === "pending") ?? this.propose(tool, summary, stopId, key);
    const decided = await this.waitForDecision(proposal);
    if (decided.status === "approved" && !decided.isUsed) {
      decided.isUsed = true;
      return;
    }
    if (decided.status === "pending") throw new ProposalPendingError(decided.id);
    throw new ControlRefusedError(`The person did not approve ${tool} (proposal ${decided.id}): it was ${describeOutcome(decided)}.`);
  }

  // The person's answer from the Journal or the notification. Returns false when the proposal is no longer pending.
  public decide(proposalId: string, decision: "approved" | "rejected"): boolean {
    const proposal = this.proposals.find((candidate) => candidate.id === proposalId);
    if (proposal?.status !== "pending") return false;
    this.settle(proposal, decision, decision === "rejected" ? "the person rejected it" : undefined);
    return true;
  }

  public setMode(mode: ControlMode): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    this.cancelPending(`the person switched to ${mode} mode`);
    this.changed({ kind: "mode", mode });
  }

  // Any debug action the person takes. It takes the lock at once, in any mode.
  public takeControl(cause: string): void {
    if (this.holderValue === "person") return;
    this.holderValue = "person";
    this.cancelPending("the person took control");
    this.options.notifyAgent({ cause, kind: "took_control" });
    this.changed({ cause, kind: "taken" });
  }

  public handBack(): void {
    if (this.holderValue === "agent") return;
    this.holderValue = "agent";
    this.options.notifyAgent({ kind: "handed_back" });
    this.changed({ kind: "handed_back" });
  }

  // A proposal is about one stop. When the stop changes, a pending proposal no longer means what the person read.
  public onStopChanged(): void {
    const stopId = this.options.currentStopId();
    for (const proposal of this.proposals) {
      if (proposal.status === "pending" && proposal.stopId !== stopId) this.settle(proposal, "cancelled", "the stop changed");
    }
  }

  public dispose(): void {
    for (const proposal of this.proposals) clearTimeout(proposal.timer);
  }

  private propose(tool: string, summary: string, stopId: number | undefined, key: string): IProposal {
    this.nextProposal++;
    const createdAt = this.now();
    const proposal: IProposal = {
      at: new Date(createdAt).toISOString(),
      expiresAt: createdAt + PROPOSAL_EXPIRY_MS,
      id: `p${this.nextProposal}`,
      isUsed: false,
      key,
      status: "pending",
      stopId,
      summary,
      timer: setTimeout(() => {
        if (proposal.status === "pending") this.settle(proposal, "expired", "no decision in 5 minutes");
      }, PROPOSAL_EXPIRY_MS),
      tool,
      waiters: new Set(),
    };
    this.proposals.push(proposal);
    while (this.proposals.length > KEPT_PROPOSALS) {
      const dropped = this.proposals.shift();
      if (dropped) clearTimeout(dropped.timer);
    }
    this.changed({ kind: "proposal", proposal: toView(proposal) });
    return proposal;
  }

  private waitForDecision(proposal: IProposal): Promise<IProposal> {
    return new Promise((resolve) => {
      const done = (settled: IProposal): void => {
        clearTimeout(timer);
        proposal.waiters.delete(done);
        resolve(settled);
      };
      const timer = setTimeout(() => done(proposal), this.waitMs);
      proposal.waiters.add(done);
    });
  }

  private settle(proposal: IProposal, decision: ProposalDecision, reason?: string): void {
    proposal.status = decision;
    proposal.decidedAt = new Date(this.now()).toISOString();
    proposal.reason = reason;
    clearTimeout(proposal.timer);
    const hadWaiters = proposal.waiters.size > 0;
    for (const waiter of [...proposal.waiters]) waiter(proposal);
    // A tool call that is still waiting hears the outcome as its result. Otherwise the agent hears it as an event.
    if (!hadWaiters) {
      this.options.notifyAgent({ decision, kind: "proposal_decided", proposalId: proposal.id, reason, tool: proposal.tool });
    }
    this.changed({ kind: "proposal", proposal: toView(proposal) });
  }

  private cancelPending(reason: string): void {
    for (const proposal of this.proposals) {
      if (proposal.status === "pending") this.settle(proposal, "cancelled", reason);
    }
  }

  private changed(record?: ControlRecord): void {
    for (const listener of this.changeListeners) listener(record);
  }
}

function toView(proposal: IProposal): IProposalView {
  return {
    at: proposal.at,
    decidedAt: proposal.decidedAt,
    id: proposal.id,
    reason: proposal.reason,
    status: proposal.status,
    stopId: proposal.stopId,
    summary: proposal.summary,
    tool: proposal.tool,
  };
}

function describeOutcome(proposal: IProposal): string {
  const { status } = proposal;
  if (status === "pending") return "still pending";
  const words = DECISION_WORDS[status];
  return proposal.reason && status === "cancelled" ? `${words}: ${proposal.reason}` : words;
}
