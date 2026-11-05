import { describe, expect, it } from "vitest";
import { assessSession } from "./session-eligibility";

const LOCAL_LAUNCH = { env: { DOTNET_ENVIRONMENT: "Development" }, request: "launch", type: "coreclr" };

describe("assessSession", () => {
  it("should allow a local coreclr launch", () => {
    expect(assessSession(LOCAL_LAUNCH)).toEqual({ isAgentVisible: true, reasons: [] });
  });

  it("should hide an attach request and a processId target", () => {
    const result = assessSession({ processId: 4321, request: "attach", type: "coreclr" });
    expect(result.isAgentVisible).toBe(false);
    expect(result.reasons).toEqual([
      "it is a 'attach' request, and only local launches are allowed",
      "it targets an existing process by processId",
    ]);
  });

  it("should hide a session that uses pipeTransport", () => {
    expect(assessSession({ ...LOCAL_LAUNCH, pipeTransport: { pipeProgram: "ssh" } }).reasons).toEqual([
      "it uses pipeTransport, which can reach another machine",
    ]);
  });

  it("should hide an unsupported debug type", () => {
    expect(assessSession({ request: "launch", type: "node" }).reasons).toEqual([
      "its debug type 'node' is not supported",
    ]);
  });

  it.each([
    ["ASPNETCORE_ENVIRONMENT", "Production"],
    ["DOTNET_ENVIRONMENT", " production "],
  ])("should hide a session where %s is %s", (variable, value) => {
    const result = assessSession({ ...LOCAL_LAUNCH, env: { [variable]: value } });
    expect(result.reasons).toEqual([`it sets ${variable} to Production`]);
  });
});
