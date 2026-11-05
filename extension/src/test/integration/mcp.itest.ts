import * as assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as vscode from "vscode";
import { agentDrives, enable, getHarness, stopAll, type IHarness } from "./harness";
import { connectAgent, drain, errorText, headersFromHelper, waitForKind, type IAgent, type IWaitEvent } from "./mcp-agent";

function rawStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" });
    const request = http.request(
      {
        headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", ...headers },
        host: "127.0.0.1",
        method: "POST",
        path: "/mcp",
        port,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

function connectRefused(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 3_000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve("timeout");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
  });
}

describe("the MCP surface", () => {
  let harness: IHarness;
  let port: number;
  let agent: IAgent | undefined;

  before(async () => {
    harness = await getHarness();
    await enable();
    await agentDrives();
    port = harness.mcp.port ?? 0;
    assert.ok(port > 0, "the MCP server did not start after consent");
  });

  afterEach(async () => {
    await agent?.close();
    agent = undefined;
    await stopAll();
  });

  it("refuses a request with no token, a wrong token, a foreign Host or a browser Origin", async () => {
    const headers = await headersFromHelper(harness.mcp.helperCommand());
    assert.equal(await rawStatus(port, headers), 200);
    assert.equal(await rawStatus(port, {}), 401);
    assert.equal(await rawStatus(port, { Authorization: `Bearer ${"0".repeat(64)}` }), 401);
    assert.equal(await rawStatus(port, { ...headers, Host: `attacker.example:${port}` }), 403);
    assert.equal(await rawStatus(port, { ...headers, Origin: "https://attacker.example" }), 403);
  });

  it("is not reachable on any address but loopback", async function () {
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((address) => address && address.family === "IPv4" && !address.internal);
    if (!external) this.skip();
    assert.equal(await connectRefused(external.address, port), "ECONNREFUSED");
    assert.equal(await connectRefused("127.0.0.1", port), "connected");
  });

  it("lets an agent start the sample app, stop at a breakpoint, read it and see stale handles", async () => {
    agent = await connectAgent(port, await headersFromHelper(harness.mcp.helperCommand()));
    const configs = await agent.json<{ isAgentVisible: boolean; name: string }[]>("list_launch_configs");
    assert.ok(configs.some((config) => config.name === "SampleApp: discount" && config.isAgentVisible));

    const breakpoint = await agent.json<{ id: string; path: string }>("set_breakpoint", {
      line: 24,
      path: "fixtures/SampleApp/Domain/Basket.cs",
    });
    assert.equal(breakpoint.path, "fixtures/SampleApp/Domain/Basket.cs");
    assert.match(errorText(await agent.call("set_breakpoint", { line: 1, path: "../outside.cs" })), /outside the workspace/);

    await agent.json("start_session", { name: "SampleApp: discount" });
    const stopped = await waitForKind(agent, "stopped");
    assert.equal(stopped.reason, "breakpoint");

    const snapshot = await agent.json<{ locals: { handle?: string; name: string }[]; stopId: number }>("get_snapshot");
    assert.equal(snapshot.stopId, stopped.stopId);
    const lines = snapshot.locals.find((local) => local.name === "lines");
    assert.ok(lines?.handle, "lines should be expandable");
    const children = await agent.json<{ name: string }[]>("get_variables", { handle: lines.handle });
    assert.ok(children.some((child) => child.name === "[0]"));

    await agent.json("step", { kind: "over" });
    await waitForKind(agent, "stopped");
    assert.match(errorText(await agent.call("get_variables", { handle: lines.handle })), /StaleHandleError/);

    const status = await agent.json<{ agentBreakpoints: unknown[]; session?: { state: string } }>("get_status");
    assert.equal(status.session?.state, "stopped");
    assert.equal(status.agentBreakpoints.length, 1);

    await agent.json("stop_session");
    await waitForKind(agent, "exited");
    assert.equal(vscode.debug.breakpoints.length, 0, "the agent's breakpoints should go when the session ends");
  });

  it("times out a wait with progress, and delivers a question the person asks", async () => {
    agent = await connectAgent(port, await headersFromHelper(harness.mcp.helperCommand()));
    await drain(agent);
    let progressCount = 0;
    const timedOut = await agent.call("wait_for_event", { timeoutSeconds: 21 }, () => progressCount++);
    assert.match(timedOut.content[0]?.type === "text" ? timedOut.content[0].text : "", /"timeout"/);
    assert.ok(progressCount >= 1, "a progress notification should arrive every 20 seconds");

    const waiting = agent.json<IWaitEvent>("wait_for_event", { timeoutSeconds: 30 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await vscode.commands.executeCommand("aiDebugger.askAgent", "Why is the amount zero?");
    const asked = await waiting;
    assert.equal(asked.event?.kind, "question");
    assert.equal(asked.event?.text, "Why is the amount zero?");
  });

  it("rotates the token on restart, and the helper returns the new one", async () => {
    const before = await headersFromHelper(harness.mcp.helperCommand());
    await vscode.commands.executeCommand("aiDebugger.restartServer");
    assert.equal(await rawStatus(port, before), 401, "the old token must stop working");
    const after = await headersFromHelper(harness.mcp.helperCommand());
    assert.notEqual(after.Authorization, before.Authorization);
    assert.equal(await rawStatus(port, after), 200);
  });
});
