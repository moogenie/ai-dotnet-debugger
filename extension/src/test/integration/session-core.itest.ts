import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { SessionEvent } from "../../session/session-events";
import type { SessionManager } from "../../session/session-manager";
import type { ISnapshotVariable } from "../../session/snapshot.types";
import { getHarness, launchConfiguration, setBreakpoint, startDebugging, stopAll, waitFor as waitForIn } from "./harness";

let sessions: SessionManager;
let events: SessionEvent[];

function waitFor<K extends SessionEvent["kind"]>(kind: K, fromIndex: number): Promise<Extract<SessionEvent, { kind: K }>> {
  return waitForIn(events, kind, fromIndex);
}

async function start(configName: string, breakpoint?: { file: string; line: number }): Promise<vscode.DebugSession> {
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  if (breakpoint) setBreakpoint(breakpoint.file, breakpoint.line);
  await startDebugging(launchConfiguration(configName));
  const session = sessions.session;
  if (!session) throw new Error("The session manager did not pick up the session.");
  return session;
}

async function readCounter(session: vscode.DebugSession, frameId: number): Promise<string> {
  const response = (await session.customRequest("evaluate", {
    context: "watch",
    expression: "this._summaryReads",
    frameId,
  })) as { result: string };
  return response.result;
}

function child(variable: ISnapshotVariable | undefined, name: string): ISnapshotVariable | undefined {
  return variable?.children?.find((candidate) => candidate.name === name);
}

describe("session core against the coreclr debugger", () => {
  before(async () => {
    const harness = await getHarness();
    sessions = harness.sessions;
    events = harness.events;
  });

  afterEach(async () => {
    await stopAll();
  });

  it("publishes stop, continue, output and exit events, and snapshots a frame without side effects", async () => {
    const mark = events.length;
    const session = await start("SampleApp: discount", { file: "fixtures/SampleApp/Domain/Basket.cs", line: 24 });
    const stopped = await waitFor("stopped", mark);
    assert.equal(stopped.reason, "breakpoint");

    const snapshot = await sessions.snapshot();
    assert.equal(snapshot.stopId, stopped.stopId);
    assert.equal(snapshot.frames[0]?.source, "fixtures/SampleApp/Domain/Basket.cs");
    assert.equal(snapshot.frames[0]?.line, 24);
    assert.equal(snapshot.frames[0]?.isUserCode, true);
    assert.deepEqual(
      snapshot.locals.map((local) => local.name),
      ["this", "productNumber", "lines", "net", "productAmount"],
    );
    const self = snapshot.locals.find((local) => local.name === "this");
    assert.match(child(self, "Summary")?.value ?? "", /Basket: 5 lines/);
    assert.equal(child(self, "_summaryReads")?.value, "0");
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 65_536);

    const lines = snapshot.locals.find((local) => local.name === "lines");
    const firstLine = await sessions.expand(child(lines, "[0]")?.handle ?? "", 1);
    assert.deepEqual(
      firstLine.filter((member) => member.name !== "EqualityContract").map((member) => [member.name, member.value]),
      [
        ["Amount", "200.00"],
        ["ProductNumber", "3"],
      ],
    );

    const frameId = ((await session.customRequest("stackTrace", { levels: 1, threadId: stopped.threadId })) as {
      stackFrames: { id: number }[];
    }).stackFrames[0]?.id;
    assert.equal(await readCounter(session, frameId ?? 0), "0", "the snapshot must not run the Summary getter");

    const beforeStep = events.length;
    await session.customRequest("next", { threadId: stopped.threadId });
    await waitFor("continued", beforeStep);
    const stepped = await waitFor("stopped", beforeStep);
    assert.equal(stepped.stopId, stopped.stopId + 1);
    await assert.rejects(sessions.expand(self?.handle ?? "", 1), { name: "StaleHandleError" });

    const beforeRun = events.length;
    await session.customRequest("continue", { threadId: stopped.threadId });
    await waitFor("continued", beforeRun);
    const exited = await waitFor("exited", beforeRun);
    assert.equal(exited.exitCode, 0);
    await waitFor("terminated", beforeRun);
    const printed = events
      .slice(mark)
      .flatMap((event) => (event.kind === "output" ? [event.text] : []))
      .join("");
    assert.match(printed, /Summary reads: 1/, "only the program itself should have read Summary");
  });

  it("publishes an exception event and snapshots the exception stop", async () => {
    const mark = events.length;
    await start("SampleApp: refund");
    const exception = await waitFor("exception", mark);
    const snapshot = await sessions.snapshot();
    assert.equal(snapshot.stopId, exception.stopId);
    assert.equal(snapshot.reason, "exception");
    assert.equal(snapshot.exception?.exceptionId, "CLR/System.NullReferenceException");
    assert.equal(snapshot.frames[0]?.source, "fixtures/SampleApp/Domain/Refunds.cs");
    assert.equal(snapshot.frames[0]?.line, 11);
    const product = snapshot.locals.find((local) => local.name === "product");
    assert.equal(child(product, "Supplier")?.value, "null");
    assert.equal(child(product, "IsDiscontinued")?.value, "true");
  });

  it("applies the snapshot limits it is given", async () => {
    const mark = events.length;
    await start("SampleApp: discount", { file: "fixtures/SampleApp/Domain/Basket.cs", line: 24 });
    await waitFor("stopped", mark);
    const snapshot = await sessions.snapshot({
      depth: 1,
      maxChildren: 1,
      maxFrames: 1,
      maxPayloadBytes: 65_536,
      maxValueChars: 5,
    });
    assert.equal(snapshot.frames.length, 1);
    assert.ok(snapshot.truncation.framesOmitted >= 1, "a two-frame stack cut to one must say so");
    const lines = snapshot.locals.find((local) => local.name === "lines");
    assert.equal(lines?.children?.length, 1);
    assert.ok((lines?.childrenOmitted ?? 0) >= 1);
    const self = snapshot.locals.find((local) => local.name === "this");
    assert.equal(self?.isValueTruncated, true);
    assert.equal(self?.value.length, 5);
  });
});
