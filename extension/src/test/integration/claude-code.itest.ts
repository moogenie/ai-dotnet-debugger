import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { claudeServerEntry } from "../../mcp/registration";
import { agentDrives, enable, getHarness, repoRoot, stopAll, type IHarness } from "./harness";

// Drives the server with the real Claude Code CLI. It costs model tokens, so it runs only when
// AI_DEBUGGER_CLAUDE_E2E=1. The prompts use the synthetic sample app only.
const ENABLED = process.env.AI_DEBUGGER_CLAUDE_E2E === "1";
const CLAUDE_TIMEOUT_MS = 600_000;
const LISTEN_POLL_MS = 500;

interface IClaudeRun {
  code: number | null;
  stderr: string;
  stdout: string;
}

function runClaude(harness: IHarness, prompt: string): Promise<IClaudeRun> {
  const port = harness.mcp.port ?? 0;
  const config = { mcpServers: { "ai-dotnet-debugger": claudeServerEntry(port, harness.mcp.helperCommand()) } };
  const args = [
    "-p",
    prompt,
    "--mcp-config",
    JSON.stringify(config),
    "--strict-mcp-config",
    "--allowedTools",
    "mcp__ai-debugger",
    "--output-format",
    "json",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: repoRoot(), shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), CLAUDE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
    child.stdin.end();
  });
}

function finalText(run: IClaudeRun): string {
  assert.equal(run.code, 0, `claude failed: ${run.stderr}`);
  const parsed = JSON.parse(run.stdout) as { is_error?: boolean; result?: string };
  // Printed so the run log carries Claude's own words as evidence.
  console.log(`Claude replied: ${parsed.result ?? ""}`);
  assert.ok(!parsed.is_error, `claude reported an error: ${parsed.result}`);
  return parsed.result ?? "";
}

function jsonIn(text: string): Record<string, unknown> {
  const match = /\{[\s\S]*\}/.exec(text);
  assert.ok(match, `no JSON object in the reply: ${text}`);
  return JSON.parse(match[0]) as Record<string, unknown>;
}

// Resolves once Claude Code is inside wait_for_event. Fails at once if Claude exits first.
async function untilListening(harness: IHarness, run: Promise<IClaudeRun>): Promise<void> {
  let exited: IClaudeRun | undefined;
  void run.then((result) => (exited = result));
  while (!harness.mcp.isAgentListening) {
    if (exited) throw new Error(`Claude Code exited before it called wait_for_event: ${exited.stdout} ${exited.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, LISTEN_POLL_MS));
  }
}

// Resolves with what the Journal shows once read() finds it. Fails at once if Claude exits first.
async function untilJournal<T>(run: Promise<IClaudeRun>, read: () => T | undefined): Promise<T> {
  let exited: IClaudeRun | undefined;
  void run.then((result) => (exited = result));
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (exited) throw new Error(`Claude Code exited before the Journal showed the narration: ${exited.stdout} ${exited.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, LISTEN_POLL_MS));
  }
}

(ENABLED ? describe : describe.skip)("Claude Code against the MCP surface", function () {
  this.timeout(CLAUDE_TIMEOUT_MS);
  let harness: IHarness;

  before(async () => {
    harness = await getHarness();
    await enable();
  });

  beforeEach(() => agentDrives());

  afterEach(() => stopAll());

  it("stops at a breakpoint, narrates it in the Journal and answers a question asked from the Journal", async () => {
    const run = runClaude(
      harness,
      "Use only the ai-dotnet-debugger MCP tools. Set a breakpoint at fixtures/SampleApp/Domain/Basket.cs line 24. " +
        "Start the launch configuration 'SampleApp: discount'. Call wait_for_event until it returns a stopped event. " +
        "Call get_snapshot. Call narrate with that stopId and one sentence about where the program stopped. " +
        "Call annotate on fixtures/SampleApp/Domain/Basket.cs line 24 with that stopId and a short note about the value of productNumber. " +
        // The prompt does not say how to link the answer: the tool description and server instructions must be enough.
        "Then call wait_for_event until it returns a question event, and answer the question in one sentence in the Journal. " +
        "Then call stop_session. Do not investigate further. " +
        'Reply with only a JSON object: {"stopReason": <the stop reason>, "localNames": [<the names of the locals>], ' +
        '"questionStopId": <the stopId in the question event>, "questionLine": <the line in the question event location>}.',
    );
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(repoRoot(), "fixtures/SampleApp/Domain/Basket.cs")));
    const narrated = await untilJournal(run, () => {
      const stop = harness.journal.state().items.find((item) => item.kind === "stop");
      const isAnnotated = harness.annotations.store.list().some((annotation) => annotation.line === 24);
      return stop?.kind === "stop" && stop.narrations.length > 0 && isAnnotated && harness.mcp.isAgentListening ? stop : undefined;
    });
    harness.journal.ask("Which line runs next, and why?");
    const result = jsonIn(finalText(await run));
    assert.equal(result.stopReason, "breakpoint");
    assert.ok(Array.isArray(result.localNames) && result.localNames.includes("lines"), JSON.stringify(result));
    assert.equal(result.questionStopId, narrated.stopId);
    assert.equal(result.questionLine, 24);
    const stop = harness.journal.state().items.find((item) => item.kind === "stop" && item.stopId === narrated.stopId);
    const notes = stop?.kind === "stop" ? stop.narrations.map((narration) => narration.text) : [];
    console.log(`Journal narrations: ${JSON.stringify(notes)}`);
    const question = harness.journal.state().items.find((item) => item.kind === "question");
    const answers = question?.kind === "question" ? (question.answers ?? []).map((answer) => answer.text) : [];
    console.log(`Answers under the question: ${JSON.stringify(answers)}`);
    assert.ok(answers.length >= 1, "Claude should answer under the question");
    const pinned = harness.journal.state().items.flatMap((item) => (item.kind === "annotation" ? [item.annotation.text] : []));
    console.log(`Annotations: ${JSON.stringify(pinned)}`);
    assert.ok(notes.length >= 1, "Claude should narrate the stop");
  });

  it("in Pair mode, waits for the person's approval, and copes when the person rejects a step", async () => {
    await vscode.commands.executeCommand("aiDebugger.setControlMode", "pair");
    await vscode.commands.executeCommand("aiDebugger.openJournal");
    const decided: string[] = [];
    let isRunning = true;
    let hasRejectedStep = false;
    // Plays the person: rejects the first step and approves every other proposal.
    const person = (async (): Promise<void> => {
      while (isRunning) {
        for (const proposal of harness.lock.describe().pending) {
          const decision = proposal.tool === "step" && !hasRejectedStep ? "rejected" : "approved";
          if (decision === "rejected") hasRejectedStep = true;
          decided.push(`${proposal.tool} ${decision}`);
          await vscode.commands.executeCommand("aiDebugger.decideProposal", proposal.id, decision);
        }
        await new Promise((resolve) => setTimeout(resolve, LISTEN_POLL_MS));
      }
    })();
    try {
      const reply = finalText(
        await runClaude(
          harness,
          "Use only the ai-dotnet-debugger MCP tools. Set a breakpoint at fixtures/SampleApp/Domain/Basket.cs line 24. " +
            "Start the launch configuration 'SampleApp: discount'. Call wait_for_event until it returns a stopped event. " +
            "Call narrate with that stopId to say you will step over. Then call step with kind over. " +
            "If the step is refused, call narrate to say so and call step with kind over once more. " +
            "After a step succeeds, call wait_for_event until it returns a stopped event and call get_snapshot. Then call stop_session. " +
            'Reply with only a JSON object: {"firstStepRefused": <true or false>, "lineAfterStep": <the top frame line after the step>}.',
        ),
      );
      const result = jsonIn(reply);
      console.log(`Person decisions: ${JSON.stringify(decided)}`);
      assert.equal(result.firstStepRefused, true);
      assert.equal(result.lineAfterStep, 25);
      assert.ok(decided.includes("step rejected") && decided.includes("step approved"), JSON.stringify(decided));
    } finally {
      isRunning = false;
      await person;
    }
  });

  // Claude Code reports the cut call as lost, gets a 401 on the next call, re-runs the headers helper and
  // retries with backoff. The reconnect took about two minutes when measured on macOS.
  it("reconnects with the new token after the server restarts", async () => {
    // The first test leaves its exit event queued. Empty the inbox so Claude's wait really waits.
    while ((await harness.gateway.waitForEvent({ timeoutSeconds: 1 })).kind !== "timeout") {
      // Keep reading.
    }
    const run = runClaude(
      harness,
      "Use only the ai-dotnet-debugger MCP tools. Call get_status. Then call wait_for_event with timeoutSeconds 60. " +
        "Whatever happens to that call, then call get_status again. " +
        'Reply with only a JSON object: {"firstStatusOk": <true or false>, "waitOutcome": <a short description>, "secondStatusOk": <true or false>}.',
    );
    await untilListening(harness, run);
    await vscode.commands.executeCommand("aiDebugger.restartServer");
    const result = jsonIn(finalText(await run));
    assert.equal(result.firstStatusOk, true);
    assert.equal(result.secondStatusOk, true, JSON.stringify(result));
  });
});
