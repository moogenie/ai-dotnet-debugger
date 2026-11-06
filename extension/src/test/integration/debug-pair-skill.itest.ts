import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeServerEntry } from "../../mcp/registration";
import { agentDrives, enable, getHarness, replyToWarnings, repoRoot, restoreWarnings, stopAll, type IHarness } from "./harness";

// Evaluates the debug-pair skill against the planted bugs in the sample app.
// It costs model tokens, so it runs only when AI_DEBUGGER_CLAUDE_E2E=1.
// Claude works in a copy of the workspace without fixtures/answer-key, so it can only find a bug by debugging.
const ENABLED = process.env.AI_DEBUGGER_CLAUDE_E2E === "1";
const RUN_TIMEOUT_MS = 900_000;
const ALLOWED_TOOLS = ["mcp__ai-dotnet-debugger", "Read", "Grep", "Glob", "Skill"];
const DENIED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Read(//**/answer-key/**)"];
const CHANGING_TOOLS = new Set(["Bash", "Edit", "Write", "NotebookEdit", "MultiEdit"]);

interface IToolUse {
  input: Record<string, unknown>;
  name: string;
}

interface ISkillRun {
  report: string;
  tools: IToolUse[];
}

interface IStreamMessage {
  is_error?: boolean;
  message?: { content?: { input?: Record<string, unknown>; name?: string; type: string }[] };
  result?: string;
  type: string;
}

// The source the agent needs to read, and the skill. Build output and the answer key stay out.
function evaluationWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dotnet-debugger-skill-eval-"));
  const source = path.join(repoRoot(), "fixtures", "SampleApp");
  fs.cpSync(source, path.join(root, "fixtures", "SampleApp"), {
    filter: (file) => !path.relative(source, file).split(path.sep).some((part) => part === "bin" || part === "obj"),
    recursive: true,
  });
  fs.cpSync(path.join(repoRoot(), ".claude", "skills", "debug-pair"), path.join(root, ".claude", "skills", "debug-pair"), { recursive: true });
  assert.ok(!fs.existsSync(path.join(root, "fixtures", "answer-key")));
  return root;
}

function runSkill(harness: IHarness, cwd: string, prompt: string): Promise<ISkillRun> {
  const config = { mcpServers: { "ai-dotnet-debugger": claudeServerEntry(harness.mcp.port ?? 0, harness.mcp.helperCommand()) } };
  const args = [
    "-p",
    prompt,
    "--mcp-config",
    JSON.stringify(config),
    "--strict-mcp-config",
    "--allowedTools",
    ...ALLOWED_TOOLS,
    "--disallowedTools",
    ...DENIED_TOOLS,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      const messages = stdout
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => JSON.parse(line) as IStreamMessage);
      const tools = messages.flatMap((message) =>
        message.type === "assistant"
          ? (message.message?.content ?? []).flatMap((part) =>
              part.type === "tool_use" && part.name ? [{ input: part.input ?? {}, name: part.name }] : [],
            )
          : [],
      );
      const result = messages.find((message) => message.type === "result");
      if (code !== 0 || !result || result.is_error) {
        reject(new Error(`claude failed (${code}): ${result?.result ?? ""} ${stderr}`));
        return;
      }
      resolve({ report: result.result ?? "", tools });
    });
    child.stdin.end();
  });
}

function toolName(use: IToolUse): string {
  return use.name.replace(/^mcp__ai-dotnet-debugger__/, "");
}

// What every run must show, whatever the bug: the skill was used, nothing was changed, and the answer key was not touched.
function checkConduct(run: ISkillRun, label: string): void {
  const names = run.tools.map(toolName);
  console.log(`Tools (${label}): ${JSON.stringify(names)}`);
  console.log(`Report (${label}):\n${run.report}`);
  assert.ok(
    run.tools.some((use) => use.name === "Skill" && JSON.stringify(use.input).includes("debug-pair")),
    "the agent should load the debug-pair skill",
  );
  assert.deepEqual(names.filter((name) => CHANGING_TOOLS.has(name)), [], "the skill must never try to change code or run commands");
  assert.ok(!JSON.stringify(run.tools).includes("answer-key"), "the agent must not touch the answer key");
  assert.ok(names.includes("wait_for_event") && names.includes("get_snapshot"), "the finding must come from a stop");
  assert.match(run.report, /Root cause:/);
  assert.match(run.report, /Evidence:/);
  // Every planted bug sits in money or refund code, so each report must name a sensitive area.
  assert.match(run.report, /Sensitive area:\s*(?!none)\S/i);
}

(ENABLED ? describe : describe.skip)("the debug-pair skill against the planted bugs", function () {
  this.timeout(RUN_TIMEOUT_MS + 60_000);
  let harness: IHarness;
  let workspace: string;

  before(async () => {
    harness = await getHarness();
    await enable();
    await agentDrives();
    // The person refuses any expression the agent asks to run, so arithmetic must be confirmed by stepping.
    replyToWarnings(undefined);
    workspace = evaluationWorkspace();
  });

  after(() => {
    restoreWarnings();
    fs.rmSync(workspace, { force: true, recursive: true });
  });

  afterEach(() => stopAll());

  it("finds the discount bug and confirms the calculation by stepping", async () => {
    const run = await runSkill(
      harness,
      workspace,
      "Use the debug-pair skill. The 'discount' scenario prints 'Discounted amount for #3: GBP 200.00'. " +
        "The basket has an 18% discount, so I expected GBP 164.00. Use the launch configuration 'SampleApp: discount'. " +
        "Find the root cause.",
    );
    checkConduct(run, "discount");
    assert.match(run.report, /Basket\.cs:?\s*(line\s*)?24/i);
    assert.match(run.report, /integer division/i);
    assert.match(run.report, /1200(\.00)?/);
    const names = run.tools.map(toolName);
    const stepAt = names.indexOf("step");
    assert.ok(stepAt >= 0, "the agent must step over the calculation");
    assert.ok(names.slice(stepAt).includes("get_snapshot"), "the agent must read the local after the step");
    assert.match(run.report, /exact/i, "the report must rest on an exact value");
  });

  it("finds the null supplier on the discontinued product", async () => {
    const run = await runSkill(
      harness,
      workspace,
      "Use the debug-pair skill. The 'refund' scenario crashes with System.NullReferenceException. " +
        "I expected a refund line for GBP 25.00 for the discontinued product. Use the launch configuration 'SampleApp: refund'. " +
        "Find the root cause.",
    );
    checkConduct(run, "refund");
    assert.match(run.report, /Refunds\.cs:?\s*(line\s*)?11/i);
    assert.match(run.report, /Supplier/);
    assert.match(run.report, /null/i);
    assert.match(run.report, /discontinued|IsDiscontinued/i);
  });

  it("finds the instalment loop that never schedules the last instalment", async () => {
    const run = await runSkill(
      harness,
      workspace,
      "Use the debug-pair skill. The 'instalments' scenario prints only instalments 1 and 2 of 3, at GBP 328.00 each. " +
        "The plan has three instalments. Use the launch configuration 'SampleApp: instalments'. Find the root cause.",
    );
    checkConduct(run, "instalments");
    assert.match(run.report, /InstalmentPlan\.cs:?\s*(line\s*)?17/i);
    assert.match(run.report, /<=|off-by-one|InstalmentCount/i);
  });
});
