import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, auditFileName, buildAuditEntry, expiredAuditFiles } from "./audit-log";

const NOW = new Date("2026-10-14T09:30:00Z");

describe("audit log", () => {
  describe("auditFileName", () => {
    it("should name the file after the UTC day", () => {
      expect(auditFileName(NOW)).toBe("audit-2026-10-14.jsonl");
    });
  });

  describe("expiredAuditFiles", () => {
    it("should pick audit files older than 14 days and ignore other files", () => {
      const names = ["audit-2026-09-29.jsonl", "audit-2026-09-30.jsonl", "audit-2026-10-14.jsonl", "notes.txt"];
      expect(expiredAuditFiles(names, NOW)).toEqual(["audit-2026-09-29.jsonl"]);
    });
  });

  describe("buildAuditEntry", () => {
    it("should record the payload size and its SHA-256", () => {
      const payload = { stopId: 1, value: "[redacted:email]" };
      const entry = buildAuditEntry({ argsSummary: "", outcome: "returned", payload, tool: "get_snapshot" }, NOW);
      const serialised = JSON.stringify(payload);
      expect(entry.payloadBytes).toBe(Buffer.byteLength(serialised));
      expect(entry.payloadSha256).toBe(createHash("sha256").update(serialised).digest("hex"));
      expect(entry.timestamp).toBe(NOW.toISOString());
    });

    it("should leave the hash out when there is no payload", () => {
      const entry = buildAuditEntry({ argsSummary: "x", outcome: "refused", tool: "evaluate" }, NOW);
      expect(entry.payloadSha256).toBeUndefined();
      expect(entry.payloadBytes).toBe(0);
    });
  });

  describe("AuditLog", () => {
    it("should append JSON Lines to today's file and prune expired files", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "ai-dotnet-debugger-audit-"));
      await writeFile(path.join(directory, "audit-2026-09-01.jsonl"), "{}\n");
      const log = new AuditLog(directory, () => NOW);
      await log.write({ argsSummary: "", outcome: "returned", payload: { a: 1 }, tool: "get_snapshot" });
      await log.write({ argsSummary: "", outcome: "refused", tool: "evaluate" });
      const lines = (await readFile(path.join(directory, "audit-2026-10-14.jsonl"), "utf8")).trim().split("\n");
      expect(lines.map((line) => (JSON.parse(line) as { tool: string }).tool)).toEqual(["get_snapshot", "evaluate"]);
      expect(await readdir(directory)).toEqual(["audit-2026-10-14.jsonl"]);
    });
  });
});
