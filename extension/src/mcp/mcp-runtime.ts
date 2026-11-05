import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentGateway } from "../guardrails/agent-gateway";
import { registerTools } from "./mcp-tools";
import { SERVER_NAME, SERVER_VERSION } from "./mcp.constants";

export type McpRequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

// The MCP SDK is large. McpHost loads this module only when the server first starts, so a VS Code window
// without consent never loads the SDK, and activation stays fast.
export function createMcpRequestHandler(gateway: AgentGateway, instructions: string): McpRequestHandler {
  return async (request, response) => {
    // Stateless: a fresh server and transport per request, so no MCP session outlives a token rotation.
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions });
    registerTools(server, gateway);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  };
}
