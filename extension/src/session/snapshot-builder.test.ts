import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, SnapshotBuilder, applyPayloadCap } from "./snapshot-builder";
import type { IDapClient, ISnapshot } from "./snapshot.types";
import { StaleHandleError, VariableHandles } from "./variable-handles";

interface IRequest {
  args: Record<string, unknown>;
  command: string;
}

// Response shapes follow spikes/dap-read/results/results-darwin.json (vsdbg, C# extension 2.160.4).
function fakeClient(localsReference = 100): { client: IDapClient; requests: IRequest[] } {
  const requests: IRequest[] = [];
  const variables: Record<number, object[]> = {
    100: [
      { name: "this", value: "{SampleApp.Domain.Basket}", variablesReference: 101 },
      { name: "productNumber [int]", value: "3", variablesReference: 0 },
      { name: "lines [IReadOnlyList]", value: "Count = 5", variablesReference: 102 },
    ],
    201: [
      { name: "Summary [string]", presentationHint: { kind: "property" }, type: "string", value: '"Basket: 5 lines"', variablesReference: 0 },
      { name: "_summaryReads [int]", presentationHint: { kind: "data" }, type: "int", value: "1", variablesReference: 0 },
    ],
    202: [
      { name: "[0] [OrderLine]", value: "{OrderLine { ProductNumber = 3, Amount = 200.00 }}", variablesReference: 203 },
      { name: "[1] [OrderLine]", value: "{OrderLine { ProductNumber = 1, Amount = 300.00 }}", variablesReference: 204 },
      { name: "Raw View", value: "", variablesReference: 205 },
    ],
    203: [
      { name: "ProductNumber [int]", presentationHint: { kind: "property" }, value: "3", variablesReference: 0 },
      { name: "Amount [decimal]", presentationHint: { kind: "property" }, value: "200.00", variablesReference: 0 },
    ],
    300: [{ name: "gone [int]", value: "?", variablesReference: 0 }],
  };
  const evaluations: Record<string, object> = {
    "lines, nse": { result: "Count = 5", type: "IReadOnlyList", variablesReference: 202 },
    "productNumber, nse": { presentationHint: { kind: "data" }, result: "3", type: "int", variablesReference: 0 },
    "this, nse": { presentationHint: { kind: "data" }, result: "{SampleApp.Domain.Basket}", type: "Basket", variablesReference: 201 },
    "this.Calculate(3).Amount": { result: "200.00", type: "decimal", variablesReference: 0 },
    "this.Calculate(3).Amount, nse": { result: "0", type: "decimal", variablesReference: 0 },
  };
  const client: IDapClient = {
    request: (command, args): Promise<unknown> => {
      const typed = args as Record<string, unknown>;
      requests.push({ args: typed, command });
      switch (command) {
        case "threads":
          return Promise.resolve({ threads: [{ id: 7, name: "Main Thread" }] });
        case "stackTrace":
          return Promise.resolve({
            stackFrames: [
              { column: 9, id: 1, line: 24, name: "Basket.Calculate", source: { path: "/repo/fixtures/Basket.cs" } },
              { column: 1, id: 2, line: 30, name: "Program.<Main>$", source: { path: "/repo/fixtures/Program.cs" } },
              { column: 0, id: 3, line: 0, name: "[External Code]", presentationHint: "subtle" },
            ],
            totalFrames: 25,
          });
        case "scopes":
          return Promise.resolve({ scopes: [{ name: "Locals", variablesReference: localsReference }] });
        case "variables":
          return Promise.resolve({ variables: variables[typed.variablesReference as number] ?? [] });
        case "evaluate": {
          const result = evaluations[typed.expression as string];
          return result ? Promise.resolve(result) : Promise.reject(new Error("evaluation failed"));
        }
        case "exceptionInfo":
          return Promise.resolve({ breakMode: "unhandled", exceptionId: "CLR/System.NullReferenceException" });
        default:
          return Promise.reject(new Error(`unexpected ${command}`));
      }
    },
  };
  return { client, requests };
}

const STOP = { reason: "breakpoint", stopId: 4, threadId: 7 };
const NO_OUTPUT = { dropped: 0, lines: [] };

describe("SnapshotBuilder", () => {
  describe("build", () => {
    it("should read the frame and thread", async () => {
      const { client } = fakeClient();
      const snapshot = await new SnapshotBuilder(client, new VariableHandles()).build(STOP, NO_OUTPUT);
      expect(snapshot.stopId).toBe(4);
      expect(snapshot.thread).toEqual({ id: 7, name: "Main Thread" });
      expect(snapshot.frames.map((frame) => frame.isUserCode)).toEqual([true, true, false]);
      expect(snapshot.truncation).toMatchObject({ framesOmitted: 22, isFramesOmittedExact: true });
      expect(snapshot.watches.isAvailable).toBe(false);
    });

    it("should list Locals once and read every local through nse", async () => {
      const { client, requests } = fakeClient();
      const snapshot = await new SnapshotBuilder(client, new VariableHandles()).build(STOP, NO_OUTPUT);
      expect(snapshot.locals.map((local) => local.name)).toEqual(["this", "productNumber", "lines"]);
      const expressions = requests.filter((r) => r.command === "evaluate").map((r) => r.args.expression);
      expect(expressions).toEqual(["this, nse", "productNumber, nse", "lines, nse"]);
      const scopeListings = requests.filter((r) => r.command === "variables" && r.args.variablesReference === 100);
      expect(scopeListings).toHaveLength(1);
    });

    it("should expand nse roots to the default depth and strip type suffixes", async () => {
      const { client } = fakeClient();
      const snapshot = await new SnapshotBuilder(client, new VariableHandles()).build(STOP, NO_OUTPUT);
      const self = snapshot.locals[0];
      expect(self?.children?.map((child) => [child.name, child.kind, child.value])).toEqual([
        ["Summary", "property", '"Basket: 5 lines"'],
        ["_summaryReads", "data", "1"],
      ]);
      const lines = snapshot.locals[2];
      expect(lines?.children?.map((child) => child.name)).toEqual(["[0]", "[1]", "Raw View"]);
      expect(lines?.children?.[0]?.children).toBeUndefined();
      expect(lines?.children?.[0]?.handle).toMatch(/^h4\.\d+$/);
    });

    it("should report a lower bound of omitted frames when the adapter gives no total", async () => {
      const { client } = fakeClient();
      const noTotal: IDapClient = {
        request: async (command, args): Promise<unknown> => {
          const response = await client.request(command, args);
          return command === "stackTrace" ? { ...(response as object), totalFrames: undefined } : response;
        },
      };
      const snapshot = await new SnapshotBuilder(noTotal, new VariableHandles()).build(STOP, NO_OUTPUT, {
        ...DEFAULT_LIMITS,
        maxFrames: 1,
      });
      expect(snapshot.frames).toHaveLength(1);
      expect(snapshot.truncation).toMatchObject({ framesOmitted: 2, isFramesOmittedExact: false });
    });

    it("should mark a local that cannot be evaluated", async () => {
      const { client } = fakeClient(300);
      const snapshot = await new SnapshotBuilder(client, new VariableHandles()).build(STOP, NO_OUTPUT);
      expect(snapshot.locals).toEqual([{ isEvaluationFailed: true, name: "gone", value: "evaluation failed" }]);
    });

    it("should add exception details on an exception stop", async () => {
      const { client } = fakeClient();
      const snapshot = await new SnapshotBuilder(client, new VariableHandles()).build(
        { ...STOP, reason: "exception" },
        NO_OUTPUT,
      );
      expect(snapshot.exception?.exceptionId).toBe("CLR/System.NullReferenceException");
    });

    it("should apply the child and value limits", async () => {
      const { client } = fakeClient();
      const snapshot = await new SnapshotBuilder(client, new VariableHandles()).build(STOP, NO_OUTPUT, {
        ...DEFAULT_LIMITS,
        maxChildren: 1,
        maxValueChars: 4,
      });
      const lines = snapshot.locals[2];
      expect(lines?.children).toHaveLength(1);
      expect(lines?.childrenOmitted).toBe(2);
      expect(snapshot.locals[0]).toMatchObject({ isValueTruncated: true, value: "{Sam" });
    });

    it("should use the source path mapper", async () => {
      const { client } = fakeClient();
      const snapshot = await new SnapshotBuilder(client, new VariableHandles(), (p) => p.replace("/repo/", "")).build(
        STOP,
        NO_OUTPUT,
      );
      expect(snapshot.frames[0]?.source).toBe("fixtures/Basket.cs");
    });
  });

  describe("accuracy labels", () => {
    it("should mark memory reads exact and interpreter results interpreted", async () => {
      const { client } = fakeClient();
      const snapshot = await new SnapshotBuilder(client, new VariableHandles()).build(STOP, NO_OUTPUT);
      const accuracy = (name: string): unknown => snapshot.locals.find((local) => local.name === name)?.accuracy;
      expect(accuracy("productNumber")).toBe("exact");
      expect(accuracy("this")).toBe("exact");
      expect(accuracy("lines")).toBe("interpreted");
      const self = snapshot.locals[0];
      expect(self?.children?.map((child) => [child.name, child.accuracy])).toEqual([
        ["Summary", "interpreted"],
        ["_summaryReads", "exact"],
      ]);
      expect(snapshot.locals[2]?.children?.[0]?.accuracy).toBe("interpreted");
    });
  });

  describe("evaluate", () => {
    it("should send a plain path with nse and keep its handle", async () => {
      const { client, requests } = fakeClient();
      const result = await new SnapshotBuilder(client, new VariableHandles()).evaluate(STOP, "this", 0, {
        isPlainPath: true,
        mode: "nse",
      });
      expect(result).toMatchObject({ mode: "nse", sentExpression: "this, nse", stopId: 4 });
      expect(result.variable.handle).toMatch(/^h4\./);
      expect(requests.filter((r) => r.command === "evaluate").map((r) => r.args.expression)).toEqual(["this, nse"]);
    });

    it("should mark an nse computation interpreted", async () => {
      const { client } = fakeClient();
      const result = await new SnapshotBuilder(client, new VariableHandles()).evaluate(
        STOP,
        "this.Calculate(3).Amount",
        0,
        { isPlainPath: false, mode: "nse" },
      );
      expect(result.variable).toMatchObject({ accuracy: "interpreted", value: "0" });
    });

    it("should run for real without nse, and return no handle or children", async () => {
      const { client, requests } = fakeClient();
      const result = await new SnapshotBuilder(client, new VariableHandles()).evaluate(
        STOP,
        "this.Calculate(3).Amount, nse",
        0,
        { isPlainPath: false, mode: "real" },
      );
      expect(result).toMatchObject({ mode: "real", sentExpression: "this.Calculate(3).Amount" });
      expect(result.variable).toMatchObject({ accuracy: "executed", value: "200.00" });
      expect(result.variable.handle).toBeUndefined();
      expect(result.variable.children).toBeUndefined();
      expect(requests.filter((r) => r.command === "evaluate").map((r) => r.args.expression)).toEqual([
        "this.Calculate(3).Amount",
      ]);
    });

    it("should refuse a frame that does not exist", async () => {
      const { client } = fakeClient();
      await expect(
        new SnapshotBuilder(client, new VariableHandles()).evaluate(STOP, "this", 9, { isPlainPath: true, mode: "nse" }),
      ).rejects.toThrow("Frame 9 does not exist");
    });
  });

  describe("expand", () => {
    it("should expand a handle from the current stop", async () => {
      const { client } = fakeClient();
      const builder = new SnapshotBuilder(client, new VariableHandles());
      const snapshot = await builder.build(STOP, NO_OUTPUT);
      const first = snapshot.locals[2]?.children?.[0]?.handle ?? "";
      const children = await builder.expand(first, 4, 1);
      expect(children.map((child) => [child.name, child.value])).toEqual([
        ["ProductNumber", "3"],
        ["Amount", "200.00"],
      ]);
    });

    it("should refuse a handle from an earlier stop", async () => {
      const { client } = fakeClient();
      const builder = new SnapshotBuilder(client, new VariableHandles());
      const snapshot = await builder.build(STOP, NO_OUTPUT);
      const handle = snapshot.locals[0]?.handle ?? "";
      await expect(builder.expand(handle, undefined, 1)).rejects.toBeInstanceOf(StaleHandleError);
      await expect(builder.expand(handle, 5, 1)).rejects.toBeInstanceOf(StaleHandleError);
    });
  });
});

describe("applyPayloadCap", () => {
  const big = (): ISnapshot => ({
    frames: [],
    locals: [
      { name: "a", value: "1" },
      { children: [{ name: "x", value: "y".repeat(2000) }], name: "b", value: "2" },
    ],
    outputTail: ["o".repeat(2000), "short"],
    reason: "step",
    stopId: 1,
    thread: { id: 1 },
    truncation: {
      framesOmitted: 0,
      isFramesOmittedExact: true,
      localsChildrenDropped: 0,
      localsDropped: 0,
      outputLinesDropped: 0,
      payloadCapApplied: false,
    },
    watches: { isAvailable: false, reason: "n/a" },
  });

  it("should leave a snapshot under the cap untouched", () => {
    const snapshot = applyPayloadCap(big(), 1_000_000);
    expect(snapshot.truncation.payloadCapApplied).toBe(false);
  });

  it("should drop children first, then old output, and record what it dropped", () => {
    const snapshot = applyPayloadCap(big(), 1200);
    expect(snapshot.truncation.payloadCapApplied).toBe(true);
    expect(snapshot.locals[1]?.children).toBeUndefined();
    expect(snapshot.locals[1]?.childrenOmitted).toBe(1);
    expect(snapshot.truncation.localsChildrenDropped).toBe(1);
    expect(snapshot.outputTail).toEqual(["short"]);
    expect(snapshot.truncation.outputLinesDropped).toBe(1);
    expect(snapshot.locals).toHaveLength(2);
  });

  it("should drop whole locals last and count them", () => {
    const snapshot = applyPayloadCap(big(), 300);
    expect(snapshot.truncation.localsDropped).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(300);
  });
});
