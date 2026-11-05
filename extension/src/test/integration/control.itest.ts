import * as assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as vscode from "vscode";
import type { IControlItem, IProposalItem } from "../../journal/webview/journal-protocol";
import { enable, getHarness, stopAll, type IHarness } from "./harness";
import { connectAgent, drain, errorText, headersFromHelper, waitForKind, type IAgent, type IWaitEvent } from "./mcp-agent";

const BASKET = "fixtures/SampleApp/Domain/Basket.cs";
const POLL_MS = 100;
const POLL_ATTEMPTS = 100;
const QUIET_MS = 1_500;

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("the control lock against the coreclr debugger", () => {
  let harness: IHarness;
  let agent: IAgent;

  async function decideNext(tool: string, decision: "approved" | "rejected"): Promise<string> {
    const proposal = await until(() => harness.lock.describe().pending.find((pending) => pending.tool === tool), `a ${tool} proposal`);
    await vscode.commands.executeCommand("aiDebugger.decideProposal", proposal.id, decision);
    return proposal.id;
  }

  // In Pair mode each control call waits for the person, so the test approves it as the person would.
  async function approved<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    const call = agent.json<T>(tool, args);
    await decideNext(tool, "approved");
    return call;
  }

  async function stoppedAtBasket(): Promise<number> {
    await approved("set_breakpoint", { line: 24, path: BASKET });
    // Starting a session needs no approval in Pair mode.
    await agent.json("start_session", { name: "SampleApp: discount" });
    return (await waitForKind(agent, "stopped")).stopId ?? 0;
  }

  // What the toolbar's Step Over button runs. VS Code ignores it until it has focused the stopped frame,
  // so the test waits for that, as a person would see the stop before pressing the button.
  async function personStepsOver(stopId: number): Promise<void> {
    await until(
      () => (vscode.debug.activeStackItem instanceof vscode.DebugStackFrame && harness.sessions.currentStop?.stopId === stopId ? true : undefined),
      "VS Code to focus the stopped frame",
    );
    await vscode.commands.executeCommand("workbench.action.debug.stepOver");
  }

  function resumes(since: number): number {
    return harness.events.slice(since).filter((event) => event.kind === "continued").length;
  }

  before(async () => {
    harness = await getHarness();
    await enable();
    await vscode.commands.executeCommand("aiDebugger.openJournal");
  });

  beforeEach(async () => {
    await vscode.commands.executeCommand("aiDebugger.setControlMode", "pair");
    await vscode.commands.executeCommand("aiDebugger.handBack");
    agent = await connectAgent(harness.mcp.port ?? 0, await headersFromHelper(harness.mcp.helperCommand()));
    await drain(agent);
  });

  afterEach(async () => {
    await agent.close();
    await vscode.commands.executeCommand("aiDebugger.setControlMode", "watch");
    await vscode.commands.executeCommand("aiDebugger.handBack");
    await stopAll();
  });

  it("in Pair mode, runs no agent step until the person approves it", async () => {
    const stopId = await stoppedAtBasket();
    const proposed = harness.journal.state().items.flatMap((item) => (item.kind === "proposal" ? [item.proposal.tool] : []));
    assert.ok(!proposed.includes("start_session"), "starting a session needs no approval in Pair mode");
    assert.ok(proposed.includes("set_breakpoint"), "a breakpoint still needs approval in Pair mode");
    const before = harness.events.length;
    const step = agent.json<{ resumedFromStopId: number }>("step", { kind: "over" });
    await sleep(QUIET_MS);
    assert.equal(resumes(before), 0, "the step must not run before the approval");
    assert.equal(harness.sessions.currentStop?.stopId, stopId);
    const shown = harness.journal.state().items.find((item): item is IProposalItem => item.kind === "proposal" && item.proposal.tool === "step");
    assert.equal(shown?.proposal.status, "pending");
    assert.equal(shown?.proposal.stopId, stopId);

    await decideNext("step", "approved");
    assert.equal((await step).resumedFromStopId, stopId);
    await waitForKind(agent, "stopped");
    assert.equal(resumes(before), 1);
  });

  it("in Pair mode, refuses a step the person rejects", async () => {
    const stopId = await stoppedAtBasket();
    const before = harness.events.length;
    const step = agent.call("step", { kind: "over" });
    await decideNext("step", "rejected");
    assert.match(errorText(await step), /ControlRefusedError: The person did not approve step .*rejected/);
    await sleep(QUIET_MS);
    assert.equal(resumes(before), 0);
    assert.equal(harness.sessions.currentStop?.stopId, stopId);
  });

  it("in Observe mode, refuses every agent step and raises no proposal", async () => {
    const stopId = await stoppedAtBasket();
    await vscode.commands.executeCommand("aiDebugger.setControlMode", "observe");
    const before = harness.events.length;
    for (const kind of ["over", "into", "out"]) {
      assert.match(errorText(await agent.call("step", { kind })), /Observe mode/);
    }
    assert.match(errorText(await agent.call("continue")), /Observe mode/);
    assert.deepEqual(harness.lock.describe().pending, []);
    await sleep(QUIET_MS);
    assert.equal(resumes(before), 0);
    assert.equal(harness.sessions.currentStop?.stopId, stopId);
    // Reading still works.
    assert.equal((await agent.json<{ stopId: number }>("get_snapshot")).stopId, stopId);
  });

  it("gives the lock to the person who presses Step Over, refuses the agent, and hands back only on request", async () => {
    const stopId = await stoppedAtBasket();
    await vscode.commands.executeCommand("aiDebugger.setControlMode", "watch");
    await personStepsOver(stopId);
    const took = await waitForKind(agent, "took_control");
    assert.match(JSON.stringify(took), /next/);
    assert.equal(harness.lock.holder, "person");
    await waitForKind(agent, "stopped");

    assert.match(errorText(await agent.call("step", { kind: "over" })), /The person has control/);
    assert.match(errorText(await agent.call("set_breakpoint", { line: 25, path: BASKET })), /The person has control/);
    const items = harness.journal.state().items.filter((item): item is IControlItem => item.kind === "control");
    assert.ok(items.some((item) => item.change === "taken"));

    await vscode.commands.executeCommand("aiDebugger.handBack");
    await waitForKind(agent, "handed_back");
    await agent.json("step", { kind: "over" });
    await waitForKind(agent, "stopped");
  });

  it("cancels the agent's waiting step when the person steps, so both never step", async () => {
    const stopId = await stoppedAtBasket();
    const before = harness.events.length;
    const step: Promise<CallToolResult> = agent.call("step", { kind: "over" });
    await until(() => harness.lock.describe().pending.find((pending) => pending.tool === "step"), "the step proposal");
    await personStepsOver(stopId);
    assert.match(errorText(await step), /cancelled: the person took control/);
    const next = await waitForKind(agent, "stopped");
    assert.notEqual(next.stopId, stopId);
    await sleep(QUIET_MS);
    assert.equal(resumes(before), 1, "only the person's step may run");
    const waited = await agent.json<IWaitEvent>("wait_for_event", { timeoutSeconds: 1 });
    assert.equal(waited.kind, "timeout");
  });
});
