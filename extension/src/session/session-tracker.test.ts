import { describe, expect, it } from "vitest";
import { SessionEventBus, type SessionEvent } from "./session-events";
import { SessionTracker } from "./session-tracker";

function setUp(): { events: SessionEvent[]; tracker: SessionTracker } {
  const bus = new SessionEventBus();
  const events: SessionEvent[] = [];
  bus.subscribe((event) => events.push(event));
  return { events, tracker: new SessionTracker(bus) };
}

const stopped = (reason: string, threadId = 7): object => ({
  body: { reason, threadId },
  event: "stopped",
  type: "event",
});
const output = (text: string, category = "stdout"): object => ({
  body: { category, output: text },
  event: "output",
  type: "event",
});

describe("SessionTracker", () => {
  describe("stops", () => {
    it("should publish a stopped event with a rising stopId", () => {
      const { events, tracker } = setUp();
      tracker.fromAdapter(stopped("breakpoint"));
      tracker.fromAdapter({ command: "continue", success: true, type: "response" });
      tracker.fromAdapter(stopped("step"));
      const stops = events.filter((event) => event.kind === "stopped");
      expect(stops.map((event) => event.stopId)).toEqual([1, 2]);
      expect(tracker.stop).toEqual({ reason: "step", stopId: 2, threadId: 7 });
    });

    it("should also publish an exception event when the stop reason is exception", () => {
      const { events, tracker } = setUp();
      tracker.fromAdapter({ ...stopped("exception"), body: { reason: "exception", text: "NullReference", threadId: 3 } });
      expect(events.map((event) => event.kind)).toEqual(["stopped", "exception"]);
      expect(events[1]).toEqual({ kind: "exception", stopId: 1, text: "NullReference", threadId: 3 });
    });
  });

  describe("resumes", () => {
    it("should publish continued for a successful step response and end the stop", () => {
      const { events, tracker } = setUp();
      tracker.fromAdapter(stopped("breakpoint"));
      tracker.fromAdapter({ command: "next", success: true, type: "response" });
      expect(events.at(-1)).toEqual({ cause: "next", kind: "continued", stopId: 1, threadId: undefined });
      expect(tracker.stop).toBeUndefined();
    });

    it("should publish continued for an adapter continued event", () => {
      const { events, tracker } = setUp();
      tracker.fromAdapter(stopped("breakpoint"));
      tracker.fromAdapter({ body: { threadId: 7 }, event: "continued", type: "event" });
      expect(events.at(-1)).toEqual({ cause: "continued-event", kind: "continued", stopId: 1, threadId: 7 });
    });

    it("should ignore a failed resume and one with no current stop", () => {
      const { events, tracker } = setUp();
      tracker.fromAdapter({ command: "continue", success: true, type: "response" });
      tracker.fromAdapter(stopped("breakpoint"));
      tracker.fromAdapter({ command: "continue", success: false, type: "response" });
      expect(events.map((event) => event.kind)).toEqual(["stopped"]);
    });
  });

  describe("output", () => {
    it("should publish output and keep whole lines in the tail", () => {
      const { events, tracker } = setUp();
      tracker.fromAdapter(output("Basket: 5 lines\nSummary "));
      tracker.fromAdapter(output("reads: 1\n"));
      expect(events.filter((event) => event.kind === "output")).toHaveLength(2);
      expect(tracker.outputTail()).toEqual({ dropped: 0, lines: ["Basket: 5 lines", "Summary reads: 1"] });
    });

    it("should keep only the last 50 lines and count the rest", () => {
      const { tracker } = setUp();
      tracker.fromAdapter(output(Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n"));
      const tail = tracker.outputTail();
      expect(tail.lines).toHaveLength(50);
      expect(tail.lines[0]).toBe("line 10");
      expect(tail.dropped).toBe(10);
    });

    it("should start a new tail when the process resumes", () => {
      const { tracker } = setUp();
      tracker.fromAdapter(stopped("breakpoint"));
      tracker.fromAdapter(output("before\n"));
      tracker.fromAdapter({ command: "continue", success: true, type: "response" });
      tracker.fromAdapter(output("after\n"));
      expect(tracker.outputTail().lines).toEqual(["after"]);
    });

    it("should leave telemetry out of the tail", () => {
      const { tracker } = setUp();
      tracker.fromAdapter(output("secret-ish telemetry\n", "telemetry"));
      expect(tracker.outputTail().lines).toEqual([]);
    });
  });

  describe("exit", () => {
    it("should publish exited and terminated, and clear the stop", () => {
      const { events, tracker } = setUp();
      tracker.fromAdapter(stopped("breakpoint"));
      tracker.fromAdapter({ body: { exitCode: 134 }, event: "exited", type: "event" });
      tracker.fromAdapter({ event: "terminated", type: "event" });
      expect(events.slice(-2)).toEqual([{ exitCode: 134, kind: "exited" }, { kind: "terminated" }]);
      expect(tracker.stop).toBeUndefined();
    });
  });

  describe("malformed messages", () => {
    it("should count and ignore messages that do not match the contract", () => {
      const { events, tracker } = setUp();
      tracker.fromAdapter("not an object");
      tracker.fromAdapter({ body: { threadId: 1 }, event: "stopped", type: "event" });
      expect(events).toEqual([]);
      expect(tracker.rejectedMessages).toBe(2);
    });
  });

  describe("who sent a control request", () => {
    const request = (command: string): object => ({ arguments: { threadId: 7 }, command, seq: 9, type: "request" });

    it("should report a control request the extension did not send as the person's", () => {
      const { events, tracker } = setUp();
      tracker.fromClient(request("next"));
      tracker.fromClient(request("pause"));
      expect(events).toEqual([
        { command: "next", kind: "person-control" },
        { command: "pause", kind: "person-control" },
      ]);
    });

    it("should not report the extension's own request, and should match each expectation once", () => {
      const { events, tracker } = setUp();
      tracker.expectFromExtension("next");
      tracker.fromClient(request("next"));
      tracker.fromClient(request("next"));
      expect(events).toEqual([{ command: "next", kind: "person-control" }]);
    });

    it("should ignore reads, stopping the session and responses", () => {
      const { events, tracker } = setUp();
      for (const command of ["stackTrace", "variables", "evaluate", "disconnect", "terminate"]) tracker.fromClient(request(command));
      tracker.fromClient({ command: "next", success: true, type: "response" });
      expect(events).toEqual([]);
    });

    it("should forget an expectation that was withdrawn or is too old", () => {
      let now = 0;
      const bus = new SessionEventBus();
      const events: SessionEvent[] = [];
      bus.subscribe((event) => events.push(event));
      const tracker = new SessionTracker(bus, () => now);
      const forget = tracker.expectFromExtension("continue");
      forget();
      tracker.fromClient(request("continue"));
      tracker.expectFromExtension("stepIn");
      now = 11_000;
      tracker.fromClient(request("stepIn"));
      expect(events).toEqual([
        { command: "continue", kind: "person-control" },
        { command: "stepIn", kind: "person-control" },
      ]);
    });
  });
});
