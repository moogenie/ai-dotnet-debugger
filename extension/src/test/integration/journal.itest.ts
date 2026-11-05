import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { IJournalState, IQuestionItem, IStopItem } from "../../journal/webview/journal-protocol";
import { agentDrives, enable, getHarness, stopAll, type IHarness } from "./harness";
import { connectAgent, drain, errorText, headersFromHelper, waitForKind, type IAgent, type IWaitEvent } from "./mcp-agent";

const BASKET = "fixtures/SampleApp/Domain/Basket.cs";
const POLL_MS = 100;
const POLL_ATTEMPTS = 100;

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function stopIn(state: IJournalState, stopId: number): IStopItem | undefined {
  return [...state.items].reverse().find((item): item is IStopItem => item.kind === "stop" && item.stopId === stopId);
}

describe("the Debug Journal", () => {
  let harness: IHarness;
  let agent: IAgent | undefined;

  before(async () => {
    harness = await getHarness();
    await enable();
    await agentDrives();
  });

  afterEach(async () => {
    await agent?.close();
    agent = undefined;
    await stopAll();
  });

  it("opens in the Run and Debug view", async () => {
    await vscode.commands.executeCommand("aiDebugger.openJournal");
    await until(() => (harness.journal.isViewVisible ? true : undefined), "the Journal view to show");
  });

  it("shows each stop with its location and narration, and sends a question with its frame to the agent", async () => {
    agent = await connectAgent(harness.mcp.port ?? 0, await headersFromHelper(harness.mcp.helperCommand()));
    await drain(agent);
    harness.journal.model.clear();
    const eventsBefore = harness.events.length;

    await agent.json("narrate", { text: "Plan: stop in Calculate and read net." });
    await agent.json("set_breakpoint", { line: 24, path: BASKET });
    await agent.json("start_session", { name: "SampleApp: discount" });
    const first = await waitForKind(agent, "stopped");
    const firstId = first.stopId ?? 0;

    // Acceptance 1: the stop appears with the location the debugger reported.
    const stop = await until(() => {
      const item = stopIn(harness.journal.state(), firstId);
      return item && item.locationState !== "pending" ? item : undefined;
    }, "the stop location");
    assert.equal(stop.locationState, "reported");
    assert.equal(stop.location?.source, BASKET);
    assert.equal(stop.location?.line, 24);
    assert.match(stop.location?.name ?? "", /Calculate/);
    assert.equal(harness.journal.state().currentStopId, firstId);

    // The narration lands on that stop, redacted like every other payload.
    const narrated = await agent.json<{ stopId: number; text: string }>("narrate", {
      stopId: firstId,
      text: "net is computed here. Owner synthetic.user@example.com.",
    });
    assert.equal(narrated.text, "net is computed here. Owner [redacted:email].");
    assert.deepEqual(
      stopIn(harness.journal.state(), firstId)?.narrations.map((narration) => narration.text),
      ["net is computed here. Owner [redacted:email]."],
    );

    // Acceptance 2: a question asked at the breakpoint reaches the agent with that frame as its context.
    harness.journal.ask("Why is net computed before the product amount?");
    const asked = await agent.json<IWaitEvent & { event?: { location?: { line: number; source?: string } } }>("wait_for_event", {
      timeoutSeconds: 10,
    });
    assert.equal(asked.event?.kind, "question");
    assert.equal(asked.event?.stopId, firstId);
    assert.equal(asked.event?.location?.source, BASKET);
    assert.equal(asked.event?.location?.line, 24);
    const question = harness.journal.state().items.find((item): item is IQuestionItem => item.kind === "question");
    assert.ok(question?.deliveredAt, "the Journal should show that the agent received the question");

    // The answer names the question, so it shows under the question, not on the stop card.
    const questionId = (asked.event as { questionId?: number } | undefined)?.questionId;
    assert.equal(questionId, question.id);
    await agent.json("narrate", { answers: questionId, text: "Net comes first because the discount applies to the whole basket." });
    const answered = harness.journal.state().items.find((item): item is IQuestionItem => item.kind === "question");
    assert.deepEqual(answered?.answers?.map((answer) => answer.text), ["Net comes first because the discount applies to the whole basket."]);
    assert.equal(stopIn(harness.journal.state(), firstId)?.narrations.length, 1, "the answer must not land on the stop card");

    // A narration for a stop that has passed is refused, not attached to the new stop.
    await agent.json("step", { kind: "over" });
    const second = await waitForKind(agent, "stopped");
    assert.match(errorText(await agent.call("narrate", { stopId: firstId, text: "late" })), /NarrationRefusedError/);
    assert.deepEqual(stopIn(harness.journal.state(), second.stopId ?? 0)?.narrations, []);
    // vsdbg can send its continued event before the step response, so either cause is a true report.
    assert.ok(["continued-event", "next"].includes(stopIn(harness.journal.state(), firstId)?.resumedBy ?? ""));

    await agent.json("stop_session");
    await waitForKind(agent, "exited");

    // Acceptance 3: every stop in the Journal is one the session reported, and nothing else was added.
    const state = harness.journal.state();
    const reported = harness.events
      .slice(eventsBefore)
      .flatMap((event) => (event.kind === "stopped" ? [event.stopId] : []));
    const shown = state.items.flatMap((item) => (item.kind === "stop" ? [item.stopId] : []));
    assert.deepEqual(shown, reported);
    assert.deepEqual(
      state.items.map((item) => item.kind),
      ["note", "session", "stop", "question", "stop", "exited"],
    );
    assert.equal(state.currentStopId, undefined);
    assert.equal(state.control.holder, "agent");
  });

  it("never says the debugger had no location when the agent stepped before it answered", async () => {
    agent = await connectAgent(harness.mcp.port ?? 0, await headersFromHelper(harness.mcp.helperCommand()));
    await drain(agent);
    await agent.json("set_breakpoint", { line: 24, path: BASKET });
    await agent.json("start_session", { name: "SampleApp: discount" });
    const first = await waitForKind(agent, "stopped");
    await agent.json("step", { kind: "over" });
    await waitForKind(agent, "stopped");
    const stop = await until(() => {
      const item = stopIn(harness.journal.state(), first.stopId ?? 0);
      return item && item.locationState !== "pending" ? item : undefined;
    }, "the first stop's location to settle");
    assert.ok(["reported", "resumed"].includes(stop.locationState), `got ${stop.locationState}`);
  });
});
