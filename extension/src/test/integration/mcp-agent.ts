import * as assert from "node:assert/strict";
import { exec } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// A test agent that talks to the extension over MCP, the way Claude Code does.
const TOOL_TIMEOUT_MS = 150_000;

// Runs the helper exactly as Claude Code does: as a shell command, reading the token from the OS credential store.
export function headersFromHelper(command: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`headers helper failed: ${stderr || error.message}`));
      else resolve(JSON.parse(stdout) as Record<string, string>);
    });
  });
}

export interface IAgent {
  call(name: string, args?: Record<string, unknown>, onprogress?: () => void): Promise<CallToolResult>;
  json<T>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export async function connectAgent(port: number, headers: Record<string, string>): Promise<IAgent> {
  const client = new Client({ name: "ai-dotnet-debugger-itest", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } }));
  const call = async (name: string, args: Record<string, unknown> = {}, onprogress?: () => void): Promise<CallToolResult> =>
    (await client.callTool({ arguments: args, name }, undefined, {
      onprogress,
      resetTimeoutOnProgress: true,
      timeout: TOOL_TIMEOUT_MS,
    })) as CallToolResult;
  return {
    call,
    close: () => client.close(),
    json: async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const result = await call(name, args);
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (result.isError) throw new Error(`${name} failed: ${text}`);
      return JSON.parse(text) as T;
    },
  };
}

export function errorText(result: CallToolResult): string {
  assert.ok(result.isError, "the tool call should have failed");
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

export interface IWaitEvent {
  event?: { kind: string; reason?: string; stopId?: number; text?: string };
  kind: string;
}

export async function waitForKind(agent: IAgent, kind: string): Promise<NonNullable<IWaitEvent["event"]>> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await agent.json<IWaitEvent>("wait_for_event", { timeoutSeconds: 60 });
    if (result.event?.kind === kind) return result.event;
  }
  throw new Error(`no ${kind} event arrived`);
}

export async function drain(agent: IAgent): Promise<void> {
  while ((await agent.json<IWaitEvent>("wait_for_event", { timeoutSeconds: 1 })).kind !== "timeout") {
    // Earlier tests leave events behind. Read them until the inbox is empty.
  }
}
