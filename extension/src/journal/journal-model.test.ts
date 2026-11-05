import { describe, expect, it } from "vitest";
import { JournalModel, MAX_ITEMS, MAX_NARRATION_CHARS, NarrationRefusedError } from "./journal-model";
import type { IStopItem } from "./webview/journal-protocol";

const LOCATION = { line: 24, name: "Basket.Calculate", source: "fixtures/SampleApp/Domain/Basket.cs" };

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 9, 18, 12, 0, tick++));
}

function stopped(model: JournalModel, stopId: number): void {
  model.onSessionEvent({ kind: "stopped", reason: "breakpoint", stopId, threadId: 1 });
}

function stops(model: JournalModel): IStopItem[] {
  return model.snapshot().items.filter((item): item is IStopItem => item.kind === "stop");
}

describe("JournalModel", () => {
  it("starts empty and invents nothing", () => {
    const model = new JournalModel();
    expect(model.snapshot()).toEqual({ currentStopId: undefined, items: [], itemsOmitted: 0 });
  });

  it("records a session, a stop, its resume and the exit with its code, in order", () => {
    const model = new JournalModel(fixedClock());
    model.onSessionEvent({ kind: "started", name: "SampleApp: discount", sessionId: "s1" });
    stopped(model, 1);
    expect(model.currentStopId).toBe(1);
    model.onSessionEvent({ cause: "next", kind: "continued", stopId: 1 });
    model.onSessionEvent({ category: "stdout", kind: "output", text: "hello" });
    model.onSessionEvent({ exitCode: 3, kind: "exited" });
    model.onSessionEvent({ kind: "terminated" });
    const { currentStopId, items } = model.snapshot();
    expect(currentStopId).toBeUndefined();
    expect(items.map((item) => item.kind)).toEqual(["session", "stop", "exited"]);
    expect(items[1]).toMatchObject({ locationState: "resumed", reason: "breakpoint", resumedBy: "next", stopId: 1 });
    expect(items[2]).toMatchObject({ exitCode: 3 });
  });

  it("shows a location only when the debugger reported one", () => {
    const model = new JournalModel();
    stopped(model, 1);
    model.setLocation(1, LOCATION);
    stopped(model, 2);
    model.setLocation(2, undefined);
    expect(stops(model).map((stop) => [stop.locationState, stop.location])).toEqual([
      ["reported", LOCATION],
      ["unavailable", undefined],
    ]);
  });

  it("says when the process resumed before the location arrived, and keeps a location that arrives late", () => {
    const model = new JournalModel();
    stopped(model, 1);
    model.onSessionEvent({ cause: "next", kind: "continued", stopId: 1 });
    expect(stops(model)[0]?.locationState).toBe("resumed");
    model.setLocation(1, undefined);
    expect(stops(model)[0]?.locationState).toBe("resumed");
    model.setLocation(1, LOCATION);
    expect(stops(model)[0]).toMatchObject({ location: LOCATION, locationState: "reported" });
  });

  it("never changes a location once it is settled, and ignores an unknown stop", () => {
    const model = new JournalModel();
    stopped(model, 1);
    model.setLocation(1, LOCATION);
    model.setLocation(1, { line: 99, name: "Other" });
    model.setLocation(7, LOCATION);
    expect(stops(model)[0]?.location).toEqual(LOCATION);
    expect(model.snapshot().items).toHaveLength(1);
  });

  it("attaches a narration to the current stop", () => {
    const model = new JournalModel();
    stopped(model, 1);
    expect(model.addNarration("  The basket is empty.  ", 1)).toEqual({ stopId: 1 });
    expect(stops(model)[0]?.narrations.map((narration) => narration.text)).toEqual(["The basket is empty."]);
  });

  it("refuses a narration for a stop that is no longer current", () => {
    const model = new JournalModel();
    stopped(model, 1);
    model.onSessionEvent({ cause: "continue", kind: "continued", stopId: 1 });
    expect(() => model.addNarration("late", 1)).toThrow(/not the current stop: the process is not stopped/);
    stopped(model, 2);
    expect(() => model.addNarration("late", 1)).toThrow(/the current stop is 2/);
    expect(stops(model).every((stop) => stop.narrations.length === 0)).toBe(true);
  });

  it("records a narration without a stop as a separate note", () => {
    const model = new JournalModel();
    stopped(model, 1);
    expect(model.addNarration("My plan: break in Settle.")).toEqual({});
    expect(model.snapshot().items.map((item) => item.kind)).toEqual(["stop", "note"]);
    expect(stops(model)[0]?.narrations).toEqual([]);
  });

  it.each(["", "   ", "x".repeat(MAX_NARRATION_CHARS + 1)])("refuses an empty or oversized narration", (text) => {
    const model = new JournalModel();
    expect(() => model.addNarration(text)).toThrow(NarrationRefusedError);
    expect(model.snapshot().items).toEqual([]);
  });

  it("gives a question the current stop and its reported location, and marks it delivered once", () => {
    const model = new JournalModel(fixedClock());
    stopped(model, 4);
    model.setLocation(4, LOCATION);
    const asked = model.addQuestion("Why is the amount zero?");
    expect(asked).toEqual({ location: LOCATION, questionId: 2, stopId: 4 });
    model.markDelivered(asked.questionId);
    const first = model.snapshot().items[1];
    model.markDelivered(asked.questionId);
    expect(model.snapshot().items[1]).toEqual(first);
    expect(first).toMatchObject({ deliveredAt: "2026-10-18T12:00:02.000Z", kind: "question", stopId: 4 });
  });

  it("asks without a stop when the process is running, and without a location the debugger has not reported", () => {
    const model = new JournalModel();
    expect(model.addQuestion("Anything yet?")).toEqual({ location: undefined, questionId: 1, stopId: undefined });
    stopped(model, 1);
    expect(model.addQuestion("Where are we?")).toEqual({ location: undefined, questionId: 3, stopId: 1 });
  });

  it("keeps the newest items and counts the ones it drops", () => {
    const model = new JournalModel();
    for (let i = 0; i < MAX_ITEMS + 5; i++) model.addNarration(`note ${i}`);
    const { items, itemsOmitted } = model.snapshot();
    expect(items).toHaveLength(MAX_ITEMS);
    expect(itemsOmitted).toBe(5);
    expect(items[0]).toMatchObject({ text: "note 5" });
  });

  it("keeps the current stop when the person clears the timeline", () => {
    const model = new JournalModel();
    model.addNarration("plan");
    stopped(model, 1);
    model.clear();
    expect(model.snapshot().items.map((item) => item.kind)).toEqual(["stop"]);
    expect(model.addNarration("still here", 1)).toEqual({ stopId: 1 });
  });

  it("tells listeners about each change, and the snapshot is a copy", () => {
    const model = new JournalModel();
    let changes = 0;
    const subscription = model.onDidChange(() => changes++);
    stopped(model, 1);
    model.setLocation(1, LOCATION);
    const copy = model.snapshot();
    (copy.items[0] as IStopItem).narrations.push({ at: "", text: "forged" });
    expect(stops(model)[0]?.narrations).toEqual([]);
    subscription.dispose();
    model.addNarration("after", 1);
    expect(changes).toBe(2);
  });

  it("records a pinned note and when and why it went, and keeps a live note when the timeline is cleared", () => {
    const model = new JournalModel(fixedClock());
    const annotation = { at: "2026-10-22T09:00:00.000Z", id: "a1", line: 25, path: "fixtures/SampleApp/Domain/Basket.cs", text: "zero" };
    model.recordAnnotation({ annotation, kind: "added" });
    model.recordAnnotation({ annotation: { ...annotation, id: "a2" }, kind: "added" });
    model.recordAnnotation({ annotations: [annotation], kind: "cleared", reason: "the person dismissed it" });
    const items = model.snapshot().items;
    expect(items[0]).toMatchObject({ annotation: { id: "a1" }, clearedBecause: "the person dismissed it", kind: "annotation" });
    expect(items[1]).toMatchObject({ annotation: { id: "a2" }, kind: "annotation" });
    expect(items[1]).not.toHaveProperty("clearedAt");
    model.clear();
    expect(model.snapshot().items.map((item) => item.kind === "annotation" && item.annotation.id)).toEqual(["a2"]);
  });

  it("shows an answer under the question it answers, even after the stop has passed", () => {
    const model = new JournalModel(fixedClock());
    stopped(model, 1);
    model.setLocation(1, LOCATION);
    const asked = model.addQuestion("Why is the amount zero?");
    model.onSessionEvent({ cause: "next", kind: "continued", stopId: 1 });
    stopped(model, 2);
    expect(model.addNarration("  The discount uses integer division.  ", undefined, asked.questionId)).toEqual({ answers: asked.questionId, stopId: 1 });
    const question = model.snapshot().items.find((item) => item.kind === "question");
    expect(question?.kind === "question" && question.answers?.map((answer) => answer.text)).toEqual(["The discount uses integer division."]);
    expect(stops(model).every((stop) => stop.narrations.length === 0)).toBe(true);
  });

  it("refuses an answer to a question that is not in the Journal", () => {
    const model = new JournalModel();
    stopped(model, 1);
    expect(() => model.addNarration("answer", 1, 99)).toThrow(/Question 99 is not in the Journal/);
    expect(stops(model)[0]?.narrations).toEqual([]);
  });

  it("still puts a narration that answers no question on its stop", () => {
    const model = new JournalModel();
    stopped(model, 1);
    model.addQuestion("A question");
    model.addNarration("About the stop", 1);
    const question = model.snapshot().items.find((item) => item.kind === "question");
    expect(question?.kind === "question" && question.answers).toBeUndefined();
    expect(stops(model)[0]?.narrations.map((narration) => narration.text)).toEqual(["About the stop"]);
  });
});
