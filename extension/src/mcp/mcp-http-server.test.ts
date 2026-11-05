import * as http from "node:http";
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { McpHttpServer, PortInUseError, type IRefusal } from "./mcp-http-server";

const TOKEN = "c".repeat(64);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}

function send(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ headers, host: "127.0.0.1", method: "POST", path: "/mcp", port }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end("{}");
  });
}

describe("McpHttpServer", () => {
  const servers: McpHttpServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  async function startServer(port: number, refusals: IRefusal[] = []): Promise<McpHttpServer> {
    const server = new McpHttpServer(
      port,
      () => TOKEN,
      (_request, response) => {
        response.writeHead(200).end("ok");
        return Promise.resolve();
      },
      (refusal) => refusals.push(refusal),
    );
    await server.start();
    servers.push(server);
    return server;
  }

  it("passes a good request to the MCP handler and refuses the rest", async () => {
    const port = await freePort();
    const refusals: IRefusal[] = [];
    await startServer(port, refusals);
    const auth = { Authorization: `Bearer ${TOKEN}`, Host: `127.0.0.1:${port}` };
    expect(await send(port, auth)).toBe(200);
    expect(await send(port, { Host: `127.0.0.1:${port}` })).toBe(401);
    expect(await send(port, { ...auth, Host: `attacker.example:${port}` })).toBe(403);
    expect(await send(port, { ...auth, Origin: "https://attacker.example" })).toBe(403);
    expect(refusals.map((refusal) => refusal.status)).toEqual([401, 403, 403]);
  });

  it("binds to the loopback address only", async () => {
    const server = await startServer(await freePort());
    expect(server.boundPort).toBeGreaterThan(0);
  });

  it("fails loudly when the port is taken, rather than moving", async () => {
    const port = await freePort();
    await startServer(port);
    await expect(startServer(port)).rejects.toBeInstanceOf(PortInUseError);
  });
});
