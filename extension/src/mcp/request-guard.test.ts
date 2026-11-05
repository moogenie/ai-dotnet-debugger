import { describe, expect, it } from "vitest";
import { checkRequest, type IRequestFacts } from "./request-guard";

const PORT = 18300;
const TOKEN = "a".repeat(64);
const GOOD: IRequestFacts = { authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${PORT}`, path: "/mcp" };

describe("checkRequest", () => {
  it("allows a loopback request with the right token", () => {
    expect(checkRequest(GOOD, PORT, TOKEN)).toEqual({ isAllowed: true });
    expect(checkRequest({ ...GOOD, host: `LOCALHOST:${PORT}` }, PORT, TOKEN)).toEqual({ isAllowed: true });
  });

  it.each([
    ["no token", { ...GOOD, authorization: undefined }, 401],
    ["a wrong token", { ...GOOD, authorization: `Bearer ${"b".repeat(64)}` }, 401],
    ["a short token", { ...GOOD, authorization: "Bearer abc" }, 401],
    ["a non-bearer scheme", { ...GOOD, authorization: `Basic ${TOKEN}` }, 401],
    ["a foreign Host", { ...GOOD, host: `evil.example:${PORT}` }, 403],
    ["the wrong port in Host", { ...GOOD, host: "127.0.0.1:80" }, 403],
    ["no Host", { ...GOOD, host: undefined }, 403],
    ["a browser Origin", { ...GOOD, origin: "http://localhost:3000" }, 403],
    ["an empty Origin", { ...GOOD, origin: "" }, 403],
    ["another path", { ...GOOD, path: "/" }, 404],
  ])("refuses %s", (_label, facts, status) => {
    expect(checkRequest(facts, PORT, TOKEN)).toMatchObject({ isAllowed: false, status });
  });

  it("refuses a browser before it compares the token", () => {
    const verdict = checkRequest({ ...GOOD, authorization: undefined, origin: "null" }, PORT, TOKEN);
    expect(verdict).toMatchObject({ status: 403 });
  });
});
