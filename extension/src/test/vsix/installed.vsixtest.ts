import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import { CredentialStore } from "../../mcp/credential-store";
import { credentialName } from "../../mcp/mcp.constants";
import { claudeServerEntry } from "../../mcp/registration";
import { SKILL_FILE, userSkillFolder } from "../../skill/skill-paths";

const EXTENSION_ID = "moogenie.ai-dotnet-debugger";
const TEST_PORT = 18399;
const POLL_MS = 250;
const POLL_ATTEMPTS = 120;
const CLAUDE_TIMEOUT_MS = 600_000;

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Answers the extension's modal prompts as a person would.
async function answering<T>(reply: string, action: () => Thenable<T>): Promise<T> {
  const original = vscode.window.showWarningMessage;
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (): Promise<string> => Promise.resolve(reply);
  try {
    return await action();
  } finally {
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = original;
  }
}

function runClaude(helperCommand: string, cwd: string, prompt: string): Promise<string> {
  const config = { mcpServers: { "ai-dotnet-debugger": claudeServerEntry(TEST_PORT, helperCommand) } };
  // Claude Code itself must use the person's own config to sign in, so the test folder is not passed on.
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  const args = ["-p", prompt, "--mcp-config", JSON.stringify(config), "--strict-mcp-config", "--allowedTools", "mcp__ai-dotnet-debugger", "--output-format", "json"];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, env, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), CLAUDE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      const parsed = code === 0 ? (JSON.parse(stdout) as { is_error?: boolean; result?: string }) : undefined;
      if (!parsed || parsed.is_error) reject(new Error(`claude failed (${code}): ${parsed?.result ?? stdout} ${stderr}`));
      else resolve(parsed.result ?? "");
    });
    child.stdin.end();
  });
}

describe("the installed .vsix", () => {
  const userData = process.env.AI_DEBUGGER_VSIX_USER_DATA ?? "";
  const extensionsDir = process.env.AI_DEBUGGER_VSIX_EXTENSIONS ?? "";

  it("loads from the installed package, not from a development folder", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed`);
    assert.ok(path.resolve(extension.extensionPath).startsWith(path.resolve(extensionsDir)), extension.extensionPath);
    assert.ok(fs.existsSync(path.join(extension.extensionPath, "dist", "extension.js")));
    assert.ok(!fs.existsSync(path.join(extension.extensionPath, "src")), "the package must not ship a src folder");
    const map = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, "dist", "extension.js.map"), "utf8")) as {
      sourcesContent?: unknown;
    };
    assert.equal(map.sourcesContent, undefined, "the source map must not carry the source text");
    assert.equal(path.dirname(path.dirname(__filename)), extension.extensionPath, "the test must run from the installed folder");
    await extension.activate();
    assert.equal(await canConnect(TEST_PORT), false, "no server may run before the person enables the workspace");
  });

  it("installs the debug-pair skill into the Claude Code config folder after asking", async () => {
    await answering("Install", () => vscode.commands.executeCommand("aiDebugger.installSkill"));
    const installed = path.join(userSkillFolder(), SKILL_FILE);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    assert.equal(fs.readFileSync(installed, "utf8"), fs.readFileSync(path.join(extension.extensionPath, "dist", "skills", "debug-pair", SKILL_FILE), "utf8"));
    assert.match(fs.readFileSync(installed, "utf8"), /Sensitive area/);
  });

  it("runs an end-to-end session with real Claude Code", async () => {
    await answering("Enable for this workspace", () => vscode.commands.executeCommand("aiDebugger.enableForWorkspace"));
    await until(() => canConnect(TEST_PORT), "the MCP server to start");
    await vscode.commands.executeCommand("aiDebugger.setControlMode", "watch");

    const scripts = path.join(userData, "User", "globalStorage", EXTENSION_ID, "credentials");
    const helper = new CredentialStore(process.platform, scripts).helperCommand(credentialName(TEST_PORT));
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const reply = await runClaude(
      helper,
      folder,
      "Use only the ai-dotnet-debugger MCP tools. Set a breakpoint at fixtures/SampleApp/Domain/Basket.cs line 24. " +
        "Start the launch configuration 'SampleApp: discount'. Call wait_for_event until it returns a stopped event. " +
        "Call get_snapshot. Call narrate with that stopId and one sentence about where it stopped. " +
        "Call annotate on that file and line with a short note about the value of productNumber. Then call stop_session. " +
        'Reply with only a JSON object: {"stopReason": <the stop reason>, "line": <the top frame line>, "productNumber": <the value of productNumber>}.',
    );
    console.log(`Claude replied: ${reply}`);
    const match = /\{[\s\S]*\}/.exec(reply);
    assert.ok(match, reply);
    const result = JSON.parse(match[0]) as { line?: unknown; stopReason?: unknown; productNumber?: unknown };
    assert.equal(result.stopReason, "breakpoint");
    assert.equal(result.line, 24);
    assert.equal(String(result.productNumber), "3");
  });
});
