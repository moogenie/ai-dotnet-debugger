import { CLIENT_TIMEOUT_MS, LOOPBACK_ADDRESS, MCP_PATH, SERVER_NAME } from "./mcp.constants";

export interface IClaudeServerEntry {
  headersHelper: string;
  timeout: number;
  type: "http";
  url: string;
}

export function serverUrl(port: number): string {
  return `http://${LOOPBACK_ADDRESS}:${port}${MCP_PATH}`;
}

export function claudeServerEntry(port: number, helperCommand: string): IClaudeServerEntry {
  return { headersHelper: helperCommand, timeout: CLIENT_TIMEOUT_MS, type: "http", url: serverUrl(port) };
}

// Argument arrays for execFile with no shell, so quoting is the same on macOS and Windows.
export function registrationCommands(entry: IClaudeServerEntry): { add: string[]; remove: string[] } {
  return {
    add: ["mcp", "add-json", "--scope", "user", SERVER_NAME, JSON.stringify(entry)],
    remove: ["mcp", "remove", "--scope", "user", SERVER_NAME],
  };
}
