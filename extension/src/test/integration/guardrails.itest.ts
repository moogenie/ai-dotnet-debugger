import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionEvent } from "../../session/session-events";
import type { ISnapshotVariable } from "../../session/snapshot.types";
import {
  enable,
  getHarness,
  launchConfiguration,
  replyToWarnings,
  repoRoot,
  restoreWarnings,
  setBreakpoint,
  startDebugging,
  stopAll,
  waitFor,
  type IHarness,
} from "./harness";

// Synthetic values from fixtures/SampleApp/Domain/TestCredentials.cs. None of them may reach the agent or the log.
const PLANTED = [
  "tok_test_9f8e7d6c5b4a39281706",
  "4111 1111 1111 1111",
  "NotARealPassword1",
  "sample_user",
  "synthetic.user@example.com",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
];
const STACK_ITEM_TIMEOUT_MS = 60_000;

function child(variable: ISnapshotVariable | undefined, name: string): ISnapshotVariable | undefined {
  return variable?.children?.find((candidate) => candidate.name === name);
}

function waitForStackItem(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (vscode.debug.activeStackItem) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("the person's debugger never stopped")), STACK_ITEM_TIMEOUT_MS);
    const listener = vscode.debug.onDidChangeActiveStackItem((item) => {
      if (!item) return;
      clearTimeout(timer);
      listener.dispose();
      resolve();
    });
  });
}

const PAUSE_ATTEMPTS = 10;
const PAUSE_RETRY_MS = 2_000;

// A pause sent before the attach completes is ignored by the adapter, so keep asking until the person's view stops.
async function pauseUntilStopped(): Promise<void> {
  for (let attempt = 1; attempt <= PAUSE_ATTEMPTS && !vscode.debug.activeStackItem; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, PAUSE_RETRY_MS));
    await vscode.commands.executeCommand("workbench.action.debug.pause");
  }
  await waitForStackItem();
}

async function readAuditLog(): Promise<string> {
  await vscode.commands.executeCommand("aiDebugger.openAuditLog");
  const document = vscode.window.activeTextEditor?.document;
  if (!document?.fileName.endsWith(".jsonl")) throw new Error("the audit log did not open");
  const text = document.getText();
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  return text;
}

describe("guardrails against the coreclr debugger", () => {
  let harness: IHarness;
  let events: SessionEvent[];

  before(async () => {
    harness = await getHarness();
    events = harness.events;
  });

  afterEach(async () => {
    restoreWarnings();
    await stopAll();
  });

  it("refuses every agent call until the person opts in to this workspace", async () => {
    await vscode.commands.executeCommand("aiDebugger.disableForWorkspace");
    await assert.rejects(harness.gateway.snapshot(), { name: "ConsentRequiredError" });
    replyToWarnings(undefined);
    await vscode.commands.executeCommand("aiDebugger.enableForWorkspace");
    restoreWarnings();
    await assert.rejects(harness.gateway.snapshot(), { name: "ConsentRequiredError" }, "dismissing the prompt must not enable it");
    await enable();
    await assert.rejects(harness.gateway.snapshot(), /No supported debug session is stopped/);
  });

  it("redacts every planted secret before it reaches the agent or the audit log", async () => {
    await enable();
    const mark = events.length;
    setBreakpoint("fixtures/SampleApp/Program.cs", 39);
    await startDebugging(launchConfiguration("SampleApp: secrets"));
    await waitFor(events, "stopped", mark);

    const snapshot = await harness.gateway.snapshot();
    const credentials = snapshot.locals.find((local) => local.name === "credentials");
    assert.ok(credentials, "the credentials local should be in the snapshot");
    assert.equal(child(credentials, "ApiToken")?.value, "[redacted:name]");
    assert.equal(child(credentials, "ContactEmail")?.value, '"[redacted:email]"');
    assert.equal(child(credentials, "CardNumber")?.value, '"[redacted:card-number]"');
    assert.equal(child(credentials, "SessionJwt")?.value, '"[redacted:jwt]"');
    assert.equal(child(credentials, "ConnectionString")?.value, "[redacted:name]");
    assert.equal(child(credentials, "Label")?.value, '"synthetic test credentials"');

    // The name rule may catch this first, because the expression contains "credentials". Either rule is fine.
    const evaluation = await harness.gateway.evaluate("credentials.ContactEmail");
    assert.match(evaluation.variable.value, /\[redacted:(email|name)\]/);

    const agentView = JSON.stringify([snapshot, evaluation]);
    const audit = await readAuditLog();
    for (const secret of PLANTED) {
      assert.ok(!agentView.includes(secret), `the agent saw ${secret.slice(0, 6)}...`);
      assert.ok(!audit.includes(secret), `the audit log holds ${secret.slice(0, 6)}...`);
    }
    assert.match(audit, /"tool":"get_snapshot"/);
    assert.match(audit, /"tool":"evaluate"/);
  });

  it("reads values through nse and asks before running a method", async () => {
    await enable();
    const mark = events.length;
    setBreakpoint("fixtures/SampleApp/Domain/Basket.cs", 24);
    await startDebugging(launchConfiguration("SampleApp: discount"));
    const stopped = await waitFor(events, "stopped", mark);

    const snapshot = await harness.gateway.snapshot();
    const self = snapshot.locals.find((local) => local.name === "this");
    assert.match(child(self, "Summary")?.value ?? "", /Basket: 5 lines/);
    const lines = snapshot.locals.find((local) => local.name === "lines");
    const firstLine = await harness.gateway.expand(child(lines, "[0]")?.handle ?? "", 1);
    assert.equal(firstLine.find((member) => member.name === "Amount")?.value, "200.00");

    const summary = await harness.gateway.evaluate("this.Summary");
    assert.equal(summary.sentExpression, "this.Summary, nse");
    assert.match(summary.variable.value, /Basket: 5 lines/);

    assert.equal(summary.variable.accuracy, "interpreted", "a property read runs the nse interpreter");
    const productNumber = await harness.gateway.evaluate("productNumber");
    assert.equal(productNumber.variable.accuracy, "exact");

    const method = "this.Calculate(3).Amount";
    replyToWarnings(undefined);
    await assert.rejects(harness.gateway.evaluate(method), { name: "ApprovalRefusedError" });
    replyToWarnings("Run under nse");
    const interpreted = await harness.gateway.evaluate(method);
    assert.equal(interpreted.sentExpression, `${method}, nse`);
    assert.equal(interpreted.variable.accuracy, "interpreted");
    replyToWarnings("Run for real");
    const executed = await harness.gateway.evaluate(method);
    restoreWarnings();
    assert.equal(executed.sentExpression, method);
    assert.equal(executed.variable.accuracy, "executed");
    assert.equal(executed.variable.value, "200.00", "the real run gives the program's own answer");
    assert.equal(executed.variable.handle, undefined, "a real-run result must not be expandable");

    const session = harness.sessions.session;
    assert.ok(session);
    const beforeRun = events.length;
    await session.customRequest("continue", { threadId: stopped.threadId });
    await waitFor(events, "terminated", beforeRun);
    const printed = events
      .slice(mark)
      .flatMap((event) => (event.kind === "output" ? [event.text] : []))
      .join("");
    assert.match(printed, /Summary reads: 1/, "no agent read may run the Summary getter for real");
  });

  it("hides a Production-environment session from the agent while the person debugs it", async () => {
    await enable();
    setBreakpoint("fixtures/SampleApp/Domain/Basket.cs", 24);
    const configuration = launchConfiguration("SampleApp: discount");
    await startDebugging({
      ...configuration,
      env: { ...(configuration.env as object), DOTNET_ENVIRONMENT: "Production" },
      name: "SampleApp: discount (Production)",
    });
    await waitForStackItem();
    assert.equal(harness.sessions.session, undefined);
    await assert.rejects(harness.gateway.snapshot(), { message: /DOTNET_ENVIRONMENT to Production/, name: "AgentBlindError" });
  });

  it("hides an attach session from the agent while the person debugs it", async () => {
    await enable();
    const dll = path.join(repoRoot(), "fixtures", "SampleApp", "bin", "Debug", "net10.0", "SampleApp.dll");
    const target = cp.spawn("dotnet", [dll, "wait"], { stdio: "ignore" });
    try {
      assert.ok(target.pid, "the wait process did not start");
      await startDebugging({ name: "attach test", processId: target.pid, request: "attach", type: "coreclr" });
      await pauseUntilStopped();
      assert.equal(harness.sessions.session, undefined);
      await assert.rejects(harness.gateway.snapshot(), { message: /'attach' request/, name: "AgentBlindError" });
    } finally {
      await stopAll();
      target.kill();
    }
  });
});
