import { describe, expect, it } from "vitest";
import type { EvaluationMode, IEvaluateOptions, IEvaluation, ISnapshot } from "../session/snapshot.types";
import type { IAgentControl } from "../control/agent-control";
import { AnnotationRefusedError, AnnotationStore } from "../annotations/annotation-store";
import { JournalModel, NarrationRefusedError } from "../journal/journal-model";
import type { IAnnotationView } from "../journal/webview/journal-protocol";
import type { WaitResult } from "../mcp/event-inbox";
import {
  AgentBlindError,
  AgentGateway,
  ApprovalRefusedError,
  ConsentRequiredError,
  ControlRefusedError,
  OPEN_CONTROL_GATE,
  type IAgentSessionSource,
  type IControlGate,
} from "./agent-gateway";
import type { AuditLog, IAuditInput } from "./audit-log";
import { Redactor } from "./redaction";

interface ISetUp {
  approvals: string[];
  audits: IAuditInput[];
  controlCalls: string[];
  evaluated: { expression: string; options: IEvaluateOptions }[];
  annotations: AnnotationStore;
  gateway: AgentGateway;
  journal: JournalModel;
}

function setUp(
  options: { approve?: EvaluationMode; blind?: string[]; consent?: boolean; failWith?: string; gate?: IControlGate } = {},
): ISetUp {
  const controlCalls: string[] = [];
  const audits: IAuditInput[] = [];
  const approvals: string[] = [];
  const evaluated: { expression: string; options: IEvaluateOptions }[] = [];
  const snapshot = {
    locals: [{ name: "ContactEmail", value: '"synthetic.user@example.com"' }],
    stopId: 2,
  } as unknown as ISnapshot;
  const sessions: IAgentSessionSource = {
    blindReasons: (): string[] | undefined => options.blind,
    currentStop: { reason: "breakpoint", stopId: 2, threadId: 1 },
    evaluate: (expression, _frameIndex, evaluateOptions): Promise<IEvaluation> => {
      evaluated.push({ expression, options: evaluateOptions });
      return Promise.resolve({
        mode: evaluateOptions.mode,
        sentExpression: `${expression}, nse`,
        stopId: 2,
        variable: { name: expression, value: "synthetic.user@example.com" },
      });
    },
    expand: (): Promise<[]> => Promise.resolve([]),
    sessionId: "session-1",
    snapshot: (): Promise<ISnapshot> =>
      options.failWith ? Promise.reject(new Error(options.failWith)) : Promise.resolve(snapshot),
  };
  const audit = {
    write: (input: IAuditInput): Promise<unknown> => {
      audits.push(input);
      return Promise.resolve(input);
    },
  } as unknown as AuditLog;
  const control = {
    output: () => ({ dropped: 0, lines: ["paid synthetic.user@example.com"] }),
    resume: () => {
      controlCalls.push("resume");
      return Promise.resolve({ command: "continue", resumedFromStopId: 2 });
    },
    setBreakpoint: (location: { line: number; path: string }): object => {
      controlCalls.push(`set ${location.path}:${location.line}`);
      return { id: "bp1", ...location };
    },
  } as unknown as IAgentControl;
  const journal = new JournalModel();
  journal.onSessionEvent({ kind: "stopped", reason: "breakpoint", stopId: 2, threadId: 1 });
  const annotations = new AnnotationStore();
  const gateway = new AgentGateway({
    annotations: {
      annotate: (input): Promise<IAnnotationView> => Promise.resolve(annotations.add(input)),
      clear: (id): IAnnotationView[] => annotations.clear("the agent cleared it", id),
    },
    approver: {
      approveEvaluate: (expression): Promise<EvaluationMode | undefined> => {
        approvals.push(expression);
        return Promise.resolve(options.approve);
      },
    },
    audit,
    consent: { isGranted: (): boolean => options.consent ?? true },
    control,
    events: {
      discardSessionEvents: (): void => undefined,
      wait: (): Promise<WaitResult> => Promise.resolve({ kind: "timeout", waitedSeconds: 1 }),
    },
    gate: options.gate ?? OPEN_CONTROL_GATE,
    journal,
    redactor: (): Redactor => new Redactor(),
    sessions,
  });
  return { annotations, approvals, audits, controlCalls, evaluated, gateway, journal };
}

describe("AgentGateway", () => {
  describe("guards", () => {
    it("should refuse everything until the person has opted in, and audit the refusal", async () => {
      const { audits, gateway } = setUp({ consent: false });
      await expect(gateway.snapshot()).rejects.toBeInstanceOf(ConsentRequiredError);
      expect(audits).toEqual([expect.objectContaining({ outcome: "refused", tool: "get_snapshot" })]);
    });

    it("should refuse an agent-blind session with the reasons", async () => {
      const { audits, gateway } = setUp({ blind: ["it is a 'attach' request"] });
      await expect(gateway.snapshot()).rejects.toBeInstanceOf(AgentBlindError);
      expect(audits[0]?.outcome).toBe("refused");
    });
  });

  describe("redaction and audit", () => {
    it("should return the snapshot redacted and audit the redacted payload", async () => {
      const { audits, gateway } = setUp();
      const snapshot = await gateway.snapshot();
      expect(snapshot.locals[0]?.value).toBe('"[redacted:email]"');
      expect(audits[0]).toMatchObject({ outcome: "returned", redactions: { email: 1 }, sessionId: "session-1", stopId: 2 });
      expect(JSON.stringify(audits)).not.toContain("synthetic.user@example.com");
    });

    it("should redact the message of a failure before it reaches the agent or the log", async () => {
      const { audits, gateway } = setUp({ failWith: "adapter said synthetic.user@example.com" });
      await expect(gateway.snapshot()).rejects.toThrow("adapter said [redacted:email]");
      expect(audits[0]).toMatchObject({ outcome: "failed", payload: { error: "adapter said [redacted:email]" } });
    });
  });

  describe("evaluate", () => {
    it("should run a plain member path under nse without asking", async () => {
      const { approvals, evaluated, gateway } = setUp();
      const result = await gateway.evaluate("this.Summary");
      expect(approvals).toEqual([]);
      expect(evaluated).toEqual([{ expression: "this.Summary", options: { isPlainPath: true, mode: "nse" } }]);
      expect(result.variable.value).toBe("[redacted:email]");
    });

    it("should ask before a method call and refuse when the person declines", async () => {
      const { approvals, audits, evaluated, gateway } = setUp({ approve: undefined });
      await expect(gateway.evaluate("this.Calculate(3)")).rejects.toBeInstanceOf(ApprovalRefusedError);
      expect(approvals).toEqual(["this.Calculate(3)"]);
      expect(evaluated).toEqual([]);
      expect(audits[0]?.outcome).toBe("refused");
    });

    it.each<EvaluationMode>(["nse", "real"])("should run a method call in the %s mode the person chose", async (mode) => {
      const { evaluated, gateway } = setUp({ approve: mode });
      await gateway.evaluate("this.Calculate(3)");
      expect(evaluated).toEqual([{ expression: "this.Calculate(3)", options: { isPlainPath: false, mode } }]);
    });
  });

  describe("control and events", () => {
    it("should pass control tools through the gate and audit a refusal", async () => {
      const gate: IControlGate = { ...OPEN_CONTROL_GATE, authorise: () => Promise.reject(new ControlRefusedError("Observe mode")) };
      const { audits, controlCalls, gateway } = setUp({ gate });
      await expect(gateway.resume()).rejects.toBeInstanceOf(ControlRefusedError);
      expect(controlCalls).toEqual([]);
      expect(audits[0]).toMatchObject({ outcome: "refused", tool: "continue" });
    });

    it("should let the agent set a breakpoint while the person debugs a blind session, but not resume", async () => {
      const { controlCalls, gateway } = setUp({ blind: ["it is a 'attach' request"] });
      await gateway.setBreakpoint({ line: 24, path: "fixtures/SampleApp/Domain/Basket.cs" });
      await expect(gateway.resume()).rejects.toBeInstanceOf(AgentBlindError);
      expect(controlCalls).toEqual(["set fixtures/SampleApp/Domain/Basket.cs:24"]);
    });

    it("should refuse control and waiting without consent", async () => {
      const { controlCalls, gateway } = setUp({ consent: false });
      await expect(gateway.setBreakpoint({ line: 1, path: "a.cs" })).rejects.toBeInstanceOf(ConsentRequiredError);
      await expect(gateway.waitForEvent({})).rejects.toBeInstanceOf(ConsentRequiredError);
      expect(controlCalls).toEqual([]);
    });

    it("should redact program output", async () => {
      const { gateway } = setUp();
      await expect(gateway.output()).resolves.toEqual({ dropped: 0, lines: ["paid [redacted:email]"] });
    });

    it("should audit each wait", async () => {
      const { audits, gateway } = setUp();
      await gateway.waitForEvent({ timeoutSeconds: 1 });
      expect(audits[0]).toMatchObject({ argsSummary: "timeoutSeconds=1", outcome: "returned", tool: "wait_for_event" });
    });
  });

  describe("narrate", () => {
    it("should show the redacted narration on the current stop and audit the same text", async () => {
      const { audits, gateway, journal } = setUp();
      await expect(gateway.narrate("Stopped where synthetic.user@example.com pays.", 2)).resolves.toEqual({
        stopId: 2,
        text: "Stopped where [redacted:email] pays.",
      });
      const stop = journal.snapshot().items[0];
      expect(stop?.kind === "stop" && stop.narrations.map((narration) => narration.text)).toEqual(["Stopped where [redacted:email] pays."]);
      expect(audits[0]).toMatchObject({ outcome: "returned", payload: { text: "Stopped where [redacted:email] pays." }, tool: "narrate" });
      expect(JSON.stringify(audits)).not.toContain("synthetic.user@example.com");
    });

    it("should refuse a narration for a stop that is not current, and audit the refusal", async () => {
      const { audits, gateway } = setUp();
      await expect(gateway.narrate("old news", 1)).rejects.toBeInstanceOf(NarrationRefusedError);
      expect(audits[0]).toMatchObject({ outcome: "refused", tool: "narrate" });
    });

    it("should refuse to narrate without consent", async () => {
      const { gateway, journal } = setUp({ consent: false });
      await expect(gateway.narrate("hello")).rejects.toBeInstanceOf(ConsentRequiredError);
      expect(journal.snapshot().items).toHaveLength(1);
    });
  });

  describe("annotate", () => {
    it("should pin the redacted note and audit the same text", async () => {
      const { annotations, audits, gateway } = setUp();
      const pinned = await gateway.annotate({ line: 25, path: "fixtures/SampleApp/Domain/Basket.cs", text: "paid synthetic.user@example.com" });
      expect(pinned).toMatchObject({ id: "a1", line: 25, text: "paid [redacted:email]" });
      expect(annotations.list().map((annotation) => annotation.text)).toEqual(["paid [redacted:email]"]);
      expect(audits[0]).toMatchObject({ outcome: "returned", tool: "annotate" });
      expect(JSON.stringify(audits)).not.toContain("synthetic.user@example.com");
    });

    it("should audit a refused note and clearing", async () => {
      const { audits, gateway } = setUp();
      await expect(gateway.clearAnnotations("a9")).rejects.toBeInstanceOf(AnnotationRefusedError);
      expect(audits[0]).toMatchObject({ outcome: "refused", tool: "clear_annotations" });
      await gateway.annotate({ line: 1, path: "a.cs", text: "x" });
      await expect(gateway.clearAnnotations()).resolves.toMatchObject({ cleared: [{ id: "a1" }] });
    });
  });

  describe("narrate as an answer", () => {
    it("should put the redacted answer under the question and audit which question it answers", async () => {
      const { audits, gateway, journal } = setUp();
      const asked = journal.addQuestion("whose email?");
      await expect(gateway.narrate("It is synthetic.user@example.com.", undefined, asked.questionId)).resolves.toEqual({
        answers: asked.questionId,
        stopId: 2,
        text: "It is [redacted:email].",
      });
      const question = journal.snapshot().items.find((item) => item.kind === "question");
      expect(question?.kind === "question" && question.answers?.[0]?.text).toBe("It is [redacted:email].");
      expect(audits[0]).toMatchObject({ argsSummary: expect.stringContaining(`answers=${asked.questionId}`) as unknown, tool: "narrate" });
    });
  });
});
