import * as http from "node:http";
import { checkRequest } from "./request-guard";
import { LOOPBACK_ADDRESS } from "./mcp.constants";

const STATUS_INTERNAL_ERROR = 500;

export class PortInUseError extends Error {
  public constructor(public readonly port: number) {
    super(
      `Port ${port} is already in use, perhaps by another VS Code window running AI Debugger. ` +
        "Close that window or change the aiDebugger.port setting. The server does not move to another port.",
    );
    this.name = "PortInUseError";
  }
}

export type McpRequestHandler = (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;

export interface IRefusal {
  reason: string;
  status: number;
}

// Binds to 127.0.0.1 only, and checks Host, Origin and the bearer token before the MCP transport sees a request.
export class McpHttpServer {
  private server: http.Server | undefined;

  public constructor(
    private readonly port: number,
    private readonly token: () => string,
    private readonly handle: McpRequestHandler,
    private readonly onRefused: (refusal: IRefusal) => void = (): void => undefined,
  ) {}

  public get boundPort(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : undefined;
  }

  public async start(): Promise<void> {
    const server = http.createServer((request, response) => void this.onRequest(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) =>
        reject(error.code === "EADDRINUSE" ? new PortInUseError(this.port) : error),
      );
      server.listen({ exclusive: true, host: LOOPBACK_ADDRESS, port: this.port }, resolve);
    });
    this.server = server;
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async onRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const verdict = checkRequest(
      {
        authorization: request.headers.authorization,
        host: request.headers.host,
        origin: request.headers.origin,
        path: new URL(request.url ?? "/", "http://localhost").pathname,
      },
      this.port,
      this.token(),
    );
    if (!verdict.isAllowed) {
      this.onRefused({ reason: verdict.reason, status: verdict.status });
      response.writeHead(verdict.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: verdict.reason }));
      return;
    }
    try {
      await this.handle(request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(STATUS_INTERNAL_ERROR, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "internal error" }));
      }
      this.onRefused({ reason: error instanceof Error ? error.message : String(error), status: STATUS_INTERNAL_ERROR });
    }
  }
}
