import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventInbox } from "./event-inbox";

describe("EventInbox", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns a queued event at once", async () => {
    const inbox = new EventInbox();
    inbox.fromSession({ kind: "stopped", reason: "breakpoint", stopId: 1, threadId: 7 });
    await expect(inbox.wait()).resolves.toMatchObject({
      droppedBefore: 0,
      event: { kind: "stopped", reason: "breakpoint", sequence: 1, stopId: 1, threadId: 7 },
      kind: "event",
    });
    expect(inbox.pending).toBe(0);
  });

  it("hands a new event to a waiting reader", async () => {
    const inbox = new EventInbox();
    const waiting = inbox.wait({ timeoutSeconds: 60 });
    expect(inbox.isListening).toBe(true);
    inbox.push({ kind: "question", stopId: 3, text: "why is the amount zero?" });
    await expect(waiting).resolves.toMatchObject({ event: { kind: "question", text: "why is the amount zero?" } });
    expect(inbox.isListening).toBe(false);
  });

  it("times out after the requested time", async () => {
    const inbox = new EventInbox();
    const waiting = inbox.wait({ timeoutSeconds: 5 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(waiting).resolves.toEqual({ kind: "timeout", waitedSeconds: 5 });
    expect(inbox.isListening).toBe(false);
  });

  it("caps a wait at 120 seconds and reports progress every 20 seconds", async () => {
    const inbox = new EventInbox();
    const progress: number[] = [];
    const waiting = inbox.wait({ onProgress: (elapsed) => progress.push(elapsed), timeoutSeconds: 900 });
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(waiting).resolves.toEqual({ kind: "timeout", waitedSeconds: 120 });
    expect(progress).toEqual([20, 40, 60, 80, 100]);
  });

  it("stops waiting when the request is cancelled", async () => {
    const inbox = new EventInbox();
    const controller = new AbortController();
    const waiting = inbox.wait({ signal: controller.signal });
    controller.abort();
    await expect(waiting).resolves.toEqual({ kind: "cancelled" });
    inbox.push({ kind: "question", text: "still there?" });
    expect(inbox.pending).toBe(1);
  });

  it("drops the oldest events when full and tells the next reader", async () => {
    const inbox = new EventInbox(2);
    for (let stopId = 1; stopId <= 4; stopId++) {
      inbox.push({ cause: "continue", kind: "continued", stopId });
    }
    await expect(inbox.wait()).resolves.toMatchObject({ droppedBefore: 2, event: { stopId: 3 } });
    await expect(inbox.wait()).resolves.toMatchObject({ droppedBefore: 0, event: { stopId: 4 } });
  });

  it("reports one exited event with the exit code when the session terminates", async () => {
    const inbox = new EventInbox();
    inbox.fromSession({ category: "stdout", kind: "output", text: "hello" });
    inbox.fromSession({ exitCode: 3, kind: "exited" });
    inbox.fromSession({ kind: "terminated" });
    expect(inbox.pending).toBe(1);
    await expect(inbox.wait()).resolves.toMatchObject({ event: { exitCode: 3, kind: "exited" } });
  });

  it("tells a listener when an item reaches a reader, whether it was queued or waited for", async () => {
    const inbox = new EventInbox();
    const delivered: number[] = [];
    inbox.listen({ onDelivered: (item) => delivered.push(item.sequence) });
    inbox.push({ kind: "question", questionId: 7, text: "queued" });
    await inbox.wait();
    const waiting = inbox.wait({ timeoutSeconds: 60 });
    inbox.push({ kind: "question", questionId: 8, text: "waited for" });
    await waiting;
    expect(delivered).toEqual([1, 2]);
  });

  it("tells a listener when a wait starts and ends", async () => {
    const inbox = new EventInbox();
    const seen: boolean[] = [];
    const subscription = inbox.listen({ onListeningChanged: () => seen.push(inbox.isListening) });
    const waiting = inbox.wait({ timeoutSeconds: 5 });
    await vi.advanceTimersByTimeAsync(5_000);
    await waiting;
    subscription.dispose();
    await inbox.wait({ signal: AbortSignal.abort(), timeoutSeconds: 1 });
    expect(seen).toEqual([true, false]);
  });

  it("discards earlier session events but keeps questions when a new session starts", async () => {
    const inbox = new EventInbox();
    inbox.push({ kind: "stopped", reason: "breakpoint", stopId: 1 });
    inbox.push({ kind: "question", text: "what is lines?" });
    inbox.push({ exitCode: 0, kind: "exited" });
    inbox.discardSessionEvents();
    expect(inbox.pending).toBe(1);
    await expect(inbox.wait()).resolves.toMatchObject({ event: { kind: "question" } });
  });
});
