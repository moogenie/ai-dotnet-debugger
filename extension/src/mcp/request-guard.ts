import { timingSafeEqual } from "node:crypto";
import { MCP_PATH } from "./mcp.constants";

export interface IRequestFacts {
  authorization?: string;
  host?: string;
  origin?: string;
  path: string;
}

export type GuardVerdict = { isAllowed: true } | { isAllowed: false; reason: string; status: number };

const BEARER_PREFIX = "Bearer ";
const STATUS_UNAUTHORISED = 401;
const STATUS_FORBIDDEN = 403;
const STATUS_NOT_FOUND = 404;

// Checks run before the MCP transport sees the request. The order matters: a browser is refused
// before the token is compared, so a page cannot probe the token through timing.
export function checkRequest(facts: IRequestFacts, port: number, token: string): GuardVerdict {
  if (facts.path !== MCP_PATH) return { isAllowed: false, reason: "unknown path", status: STATUS_NOT_FOUND };
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!facts.host || !allowedHosts.includes(facts.host.toLowerCase())) {
    return { isAllowed: false, reason: "Host header is not loopback on the configured port", status: STATUS_FORBIDDEN };
  }
  if (facts.origin !== undefined) {
    return { isAllowed: false, reason: "browser requests are refused", status: STATUS_FORBIDDEN };
  }
  if (!facts.authorization?.startsWith(BEARER_PREFIX) || !tokensMatch(facts.authorization.slice(BEARER_PREFIX.length), token)) {
    return { isAllowed: false, reason: "missing or wrong bearer token", status: STATUS_UNAUTHORISED };
  }
  return { isAllowed: true };
}

function tokensMatch(offered: string, expected: string): boolean {
  const a = Buffer.from(offered, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
