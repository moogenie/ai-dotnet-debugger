import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlRefusedError } from "../guardrails/agent-gateway";
import { ControlLock, ProposalPendingError, PROPOSAL_EXPIRY_MS, type ControlEvent, type ControlRecord } from "./control-lock";

const WAIT_MS = 1_000;

interface ISetUp {
  events: ControlEvent[];
  lock: ControlLock;
  records: ControlRecord[];
  stop: { id: number | undefined };
}

function setUp(): ISetUp {
  const events: ControlEvent[] = [];
  const records: ControlRecord[] = [];
  const stop = { id: 1 as number | undefined };
  const lock = new ControlLock({
    currentStopId: (): number | undefined => stop.id,
    notifyAgent: (event): number => events.push(event),
    waitMs: WAIT_MS,
  });
  lock.onDidChange((record) => {
    if (record) records.push(record);
  });
  return { events, lock, records, stop };
}

function pendingId(lock: ControlLock): string {
  const id = lock.describe().pending[0]?.id;
  if (!id) throw new Error("no proposal is pending");
  return id;
}

describe("ControlLock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts in Pair mode with the agent holding the lock", () => {
    const { lock } = setUp();
    expect(lock.describe()).toEqual({ holder: "agent", mode: "pair", pending: [] });
  });

  describe("Pair mode", () => {
    it("runs nothing until the person approves, then lets the call through", async () => {
      const { events, lock, records } = setUp();
      let isAllowed = false;
      const call = lock.authorise("step", "kind=over").then(() => (isAllowed = true));
      await vi.advanceTimersByTimeAsync(10);
      expect(isAllowed).toBe(false);
      expect(lock.describe().pending).toMatchObject([{ id: "p1", status: "pending", stopId: 1, summary: "kind=over", tool: "step" }]);
      expect(lock.decide("p1", "approved")).toBe(true);
      await call;
      expect(isAllowed).toBe(true);
      expect(events).toEqual([]);
      expect(records.map((record) => record.kind === "proposal" && record.proposal.status)).toEqual(["pending", "approved"]);
    });

    it("refuses the call when the person rejects it", async () => {
      const { lock } = setUp();
      const call = lock.authorise("continue", "");
      lock.decide(pendingId(lock), "rejected");
      await expect(call).rejects.toThrow(/did not approve continue \(proposal p1\): it was rejected/);
    });

    it("tells the agent the proposal is still pending when the wait ends, then sends the decision as an event", async () => {
      const { events, lock } = setUp();
      const call = lock.authorise("step", "kind=over");
      const settled = expect(call).rejects.toBeInstanceOf(ProposalPendingError);
      await vi.advanceTimersByTimeAsync(WAIT_MS);
      await settled;
      lock.decide("p1", "approved");
      expect(events).toEqual([{ decision: "approved", kind: "proposal_decided", proposalId: "p1", reason: undefined, tool: "step" }]);
      // The same call at the same stop now runs once, without a new proposal.
      await expect(lock.authorise("step", "kind=over")).resolves.toBeUndefined();
      const again = lock.authorise("step", "kind=over");
      expect(lock.describe().pending.map((proposal) => proposal.id)).toEqual(["p2"]);
      lock.decide("p2", "rejected");
      await expect(again).rejects.toBeInstanceOf(ControlRefusedError);
    });

    it("joins a repeated call to the proposal already waiting", async () => {
      const { lock } = setUp();
      const first = lock.authorise("pause", "");
      const second = lock.authorise("pause", "");
      expect(lock.describe().pending).toHaveLength(1);
      lock.decide("p1", "approved");
      await first;
      await expect(second).rejects.toThrow(/approved/);
    });

    it("expires a proposal after 5 minutes", async () => {
      const { events, lock } = setUp();
      const settled = expect(lock.authorise("step", "kind=into")).rejects.toBeInstanceOf(ProposalPendingError);
      await vi.advanceTimersByTimeAsync(WAIT_MS);
      await settled;
      await vi.advanceTimersByTimeAsync(PROPOSAL_EXPIRY_MS);
      expect(events).toMatchObject([{ decision: "expired", kind: "proposal_decided", proposalId: "p1" }]);
      expect(lock.decide("p1", "approved")).toBe(false);
    });

    it("cancels a proposal when the stop changes, so an approval never applies to a stop the person did not see", async () => {
      const { lock, stop } = setUp();
      const call = lock.authorise("step", "kind=over");
      stop.id = 2;
      lock.onStopChanged();
      await expect(call).rejects.toThrow(/cancelled: the stop changed/);
    });

    it("does not reuse an approval at a later stop", async () => {
      const { lock, stop } = setUp();
      const settled = expect(lock.authorise("step", "kind=over")).rejects.toBeInstanceOf(ProposalPendingError);
      await vi.advanceTimersByTimeAsync(WAIT_MS);
      await settled;
      lock.decide("p1", "approved");
      stop.id = 2;
      void lock.authorise("step", "kind=over").catch(() => undefined);
      expect(lock.describe().pending).toMatchObject([{ id: "p2", stopId: 2 }]);
    });
  });

  it("starts a session without a proposal in Pair mode, but still refuses it in Observe mode or while the person has control", async () => {
    const { lock } = setUp();
    await expect(lock.authorise("start_session", "name=SampleApp: discount")).resolves.toBeUndefined();
    expect(lock.describe().pending).toEqual([]);
    lock.takeControl("the person's continue request");
    await expect(lock.authorise("start_session", "name=SampleApp: discount")).rejects.toThrow(/The person has control/);
    lock.handBack();
    lock.setMode("observe");
    await expect(lock.authorise("start_session", "name=SampleApp: discount")).rejects.toThrow(/Observe mode/);
  });

  it("still asks before stopping a session in Pair mode", () => {
    const { lock } = setUp();
    void lock.authorise("stop_session", "").catch(() => undefined);
    expect(lock.describe().pending).toMatchObject([{ tool: "stop_session" }]);
  });

  it("refuses every control call in Observe mode", async () => {
    const { lock } = setUp();
    lock.setMode("observe");
    await expect(lock.authorise("step", "kind=over")).rejects.toThrow(/Observe mode/);
    await expect(lock.authorise("set_breakpoint", "a.cs:1")).rejects.toThrow(/Observe mode/);
    expect(lock.describe().pending).toEqual([]);
  });

  it("lets control calls through at once in Watch mode", async () => {
    const { lock } = setUp();
    lock.setMode("watch");
    await expect(lock.authorise("step", "kind=over")).resolves.toBeUndefined();
  });

  it("cancels waiting proposals when the person changes the mode", async () => {
    const { lock, records } = setUp();
    const call = lock.authorise("continue", "");
    lock.setMode("watch");
    await expect(call).rejects.toThrow(/switched to watch mode/);
    expect(records.at(-1)).toEqual({ kind: "mode", mode: "watch" });
  });

  describe("taking control", () => {
    it.each(["pair", "watch", "observe"] as const)("gives the person the lock in %s mode and refuses the agent", async (mode) => {
      const { events, lock } = setUp();
      lock.setMode(mode);
      lock.takeControl("the person's next request");
      expect(lock.holder).toBe("person");
      expect(events).toEqual([{ cause: "the person's next request", kind: "took_control" }]);
      lock.setMode("watch");
      await expect(lock.authorise("step", "kind=over")).rejects.toThrow(/The person has control/);
    });

    it("cancels a waiting proposal, so the agent's step cannot run after the person acted", async () => {
      const { lock } = setUp();
      const call = lock.authorise("step", "kind=over");
      lock.takeControl("the person's continue request");
      await expect(call).rejects.toThrow(/cancelled: the person took control/);
      expect(lock.decide("p1", "approved")).toBe(false);
    });

    it("tells the agent once, and hands back only when the person chooses", async () => {
      const { events, lock } = setUp();
      lock.setMode("watch");
      lock.takeControl("a");
      lock.takeControl("b");
      lock.handBack();
      lock.handBack();
      expect(events).toEqual([{ cause: "a", kind: "took_control" }, { kind: "handed_back" }]);
      await expect(lock.authorise("step", "kind=over")).resolves.toBeUndefined();
    });
  });
});
