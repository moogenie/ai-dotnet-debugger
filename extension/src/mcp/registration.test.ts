import { describe, expect, it } from "vitest";
import { claudeServerEntry, registrationCommands } from "./registration";

describe("registration", () => {
  const helper = '/bin/sh "/Users/a/Library/Application Support/x/headers-helper.sh" ai-dotnet-debugger-mcp-18300';

  it("registers an HTTP server on loopback with the helper and a 150-second timeout", () => {
    expect(claudeServerEntry(18300, helper)).toEqual({
      headersHelper: helper,
      timeout: 150_000,
      type: "http",
      url: "http://127.0.0.1:18300/mcp",
    });
  });

  it("passes the entry as one argument, at user scope", () => {
    const { add, remove } = registrationCommands(claudeServerEntry(18301, helper));
    expect(add.slice(0, 5)).toEqual(["mcp", "add-json", "--scope", "user", "ai-dotnet-debugger"]);
    expect(add).toHaveLength(6);
    expect(JSON.parse(add[5] ?? "")).toMatchObject({ headersHelper: helper, url: "http://127.0.0.1:18301/mcp" });
    expect(remove).toEqual(["mcp", "remove", "--scope", "user", "ai-dotnet-debugger"]);
  });
});
