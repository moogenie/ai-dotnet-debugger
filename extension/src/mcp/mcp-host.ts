import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentGateway, IConsentCheck } from "../guardrails/agent-gateway";
import { CredentialStore } from "./credential-store";
import type { EventInbox } from "./event-inbox";
import { McpHttpServer } from "./mcp-http-server";
import type { McpRequestHandler } from "./mcp-runtime";
import { credentialName, DEFAULT_PORT, TOKEN_BYTES } from "./mcp.constants";
import { claudeServerEntry, registrationCommands, serverUrl } from "./registration";

const SCRIPT_FILES = ["headers-helper.sh", "headers-helper.ps1", "credential-store.ps1"];
const EXECUTABLE = 0o755;
const REGISTER_CHOICE = "Register";
const PORT_SETTING = "port";
const JSON_INDENT = 2;

const INSTRUCTIONS =
  "These tools drive the VS Code debugger alongside a person, on a local process with test data. " +
  "Typical loop: list_launch_configs, set_breakpoint, start_session, then wait_for_event until it returns 'stopped'. " +
  "Read with get_snapshot, get_variables and evaluate, then step or continue and wait again. " +
  "At each stop, call narrate with the stopId to tell the person what you see and what you will do next. " +
  "When you find something on a specific line, pin it there with annotate. " +
  "A 'question' event is the person asking you something from their Debug Journal. It carries a questionId and the stopId and location they asked at. " +
  "Answer it with narrate, passing the questionId as answers, and in the chat. " +
  "Control: the person chooses a mode. In Pair mode, the default, every tool that changes the debugger except start_session waits for the person's approval in VS Code; " +
  "narrate first so they know why. In Observe mode those tools are refused. If the person presses a debug control, you get 'took_control' " +
  "and those tools are refused until 'handed_back'. get_status shows the mode and who holds control. " +
  "Treat 'interpreted' values as unconfirmed. Confirm money or arithmetic values by stepping and reading the local.";

export interface IMcpHostInfo {
  helperCommand(): string;
  readonly isAgentListening: boolean;
  readonly port: number | undefined;
}

// Runs the MCP server while the workspace has consent. A new token is written on every start,
// only after the port is bound, so a second window that loses the port never rotates the first window's token.
export class McpHost implements vscode.Disposable, IMcpHostInfo {
  private server: McpHttpServer | undefined;
  private token = "";
  private runningPort: number | undefined;
  private handler: Promise<McpRequestHandler> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly gateway: AgentGateway,
    private readonly inbox: EventInbox,
    private readonly consent: IConsentCheck,
    private readonly log: vscode.OutputChannel,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((change) => {
        if (change.affectsConfiguration(`aiDebugger.${PORT_SETTING}`) && this.server) void this.restart();
      }),
    );
  }

  public get isAgentListening(): boolean {
    return this.inbox.isListening;
  }

  public get port(): number | undefined {
    return this.runningPort;
  }

  public helperCommand(): string {
    return this.store().helperCommand(credentialName(this.configuredPort()));
  }

  public async syncWithConsent(): Promise<void> {
    if (this.consent.isGranted()) await this.start();
    else await this.stop();
  }

  public async start(): Promise<void> {
    if (this.server) return;
    const port = this.configuredPort();
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    const server = new McpHttpServer(
      port,
      () => this.token,
      (request, response) => this.handleMcp(request, response),
      (refusal) => this.log.appendLine(`Refused a request (${refusal.status}): ${refusal.reason}`),
    );
    try {
      await server.start();
    } catch (error) {
      void vscode.window.showErrorMessage(`AI Debugger could not start its MCP server. ${errorText(error)}`);
      return;
    }
    try {
      await this.installScripts();
      await this.store().write(credentialName(port), token);
    } catch (error) {
      await server.stop();
      void vscode.window.showErrorMessage(`AI Debugger could not store its token, so the server is stopped. ${errorText(error)}`);
      return;
    }
    this.token = token;
    this.server = server;
    this.runningPort = port;
    this.log.appendLine(`MCP server listening on ${serverUrl(port)}`);
  }

  public async stop(): Promise<void> {
    const server = this.server;
    const port = this.runningPort;
    this.server = undefined;
    this.runningPort = undefined;
    this.token = "";
    if (!server || port === undefined) return;
    await server.stop();
    try {
      await this.store().delete(credentialName(port));
    } catch (error) {
      this.log.appendLine(`Could not delete the token: ${errorText(error)}`);
    }
    this.log.appendLine("MCP server stopped.");
  }

  public async restart(): Promise<void> {
    await this.stop();
    await this.syncWithConsent();
  }

  public registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand("aiDebugger.registerWithClaudeCode", () => this.registerWithClaudeCode()),
      vscode.commands.registerCommand("aiDebugger.restartServer", () => this.restart()),
    ];
  }

  public dispose(): void {
    void this.stop();
    this.disposables.forEach((disposable) => void disposable.dispose());
  }

  private async handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.handler ??= import("./mcp-runtime.js").then(({ createMcpRequestHandler }) => createMcpRequestHandler(this.gateway, INSTRUCTIONS));
    await (await this.handler)(request, response);
  }

  private async registerWithClaudeCode(): Promise<void> {
    if (!this.consent.isGranted()) {
      void vscode.window.showErrorMessage("Run 'AI Debugger: Enable for this workspace' first.");
      return;
    }
    const entry = claudeServerEntry(this.configuredPort(), this.helperCommand());
    const commands = registrationCommands(entry);
    const choice = await vscode.window.showWarningMessage(
      "Register AI Debugger with Claude Code for your user?",
      {
        detail:
          `This runs 'claude ${commands.remove.join(" ")}' and then 'claude ${commands.add.slice(0, -1).join(" ")}' with this entry:\n\n` +
          JSON.stringify(entry, undefined, JSON_INDENT),
        modal: true,
      },
      REGISTER_CHOICE,
    );
    if (choice !== REGISTER_CHOICE) return;
    await runClaude(commands.remove).catch(() => undefined);
    try {
      await runClaude(commands.add);
      const choice = await vscode.window.showInformationMessage(
        "AI Debugger is registered with Claude Code. Start a new Claude Code session to use it.",
        "Install the debug-pair skill too",
      );
      if (choice) await vscode.commands.executeCommand("aiDebugger.installSkill");
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Registration failed: ${errorText(error)}. Check that the claude command is on PATH, or run 'claude ${commands.add.slice(0, -1).join(" ")} '<entry>'' yourself.`,
      );
    }
  }

  private async installScripts(): Promise<void> {
    const target = this.scriptsFolder();
    await mkdir(target, { recursive: true });
    const source = path.join(this.context.extensionUri.fsPath, "resources", "credentials");
    for (const file of SCRIPT_FILES) {
      await copyFile(path.join(source, file), path.join(target, file));
    }
    if (process.platform !== "win32") await chmod(path.join(target, "headers-helper.sh"), EXECUTABLE);
  }

  private store(): CredentialStore {
    return new CredentialStore(process.platform, this.scriptsFolder());
  }

  private scriptsFolder(): string {
    return path.join(this.context.globalStorageUri.fsPath, "credentials");
  }

  private configuredPort(): number {
    return vscode.workspace.getConfiguration("aiDebugger").get<number>(PORT_SETTING, DEFAULT_PORT);
  }
}

function runClaude(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("claude", args, { shell: false, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve();
    });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
