// Process topology, token and endpoint discovery, registration and stop-event delivery values.
export const DEFAULT_PORT = 18300;
export const LOOPBACK_ADDRESS = "127.0.0.1";
export const MCP_PATH = "/mcp";
export const SERVER_NAME = "ai-dotnet-debugger";
export const SERVER_VERSION = "0.0.1";

export const TOKEN_BYTES = 32; // 256 bits
export const CREDENTIAL_ACCOUNT = "ai-dotnet-debugger";

// The port is part of the name, so a test instance on another port never rotates the person's real token.
export function credentialName(port: number): string {
  return `ai-dotnet-debugger-mcp-${port}`;
}

export const CLIENT_TIMEOUT_MS = 150_000;
export const MAX_WAIT_SECONDS = 120;
export const PROGRESS_INTERVAL_MS = 20_000;
export const INBOX_CAPACITY = 100;
