import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import * as path from "node:path";

export const AUDIT_RETENTION_DAYS = 14;
const MS_PER_DAY = 86_400_000;
const FILE_PATTERN = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const ISO_DATE_LENGTH = 10;

export type AuditOutcome = "returned" | "refused" | "failed";

export interface IAuditEntry {
  argsSummary: string;
  outcome: AuditOutcome;
  payload?: unknown;
  payloadBytes: number;
  payloadSha256?: string;
  redactions: Record<string, number>;
  sessionId?: string;
  stopId?: number;
  timestamp: string;
  tool: string;
}

export interface IAuditInput {
  argsSummary: string;
  outcome: AuditOutcome;
  payload?: unknown;
  redactions?: Record<string, number>;
  sessionId?: string;
  stopId?: number;
  tool: string;
}

export function auditFileName(date: Date): string {
  return `audit-${date.toISOString().slice(0, ISO_DATE_LENGTH)}.jsonl`;
}

export function expiredAuditFiles(fileNames: readonly string[], now: Date): string[] {
  const cutoff = now.getTime() - AUDIT_RETENTION_DAYS * MS_PER_DAY;
  return fileNames.filter((name) => {
    const day = FILE_PATTERN.exec(name)?.[1];
    // A day's file expires only when its last possible entry is past retention.
    return day !== undefined && Date.parse(`${day}T00:00:00Z`) + MS_PER_DAY <= cutoff;
  });
}

// The payload is redacted before it reaches here, so the log never holds a raw value.
export function buildAuditEntry(input: IAuditInput, now: Date): IAuditEntry {
  const serialised = input.payload === undefined ? "" : JSON.stringify(input.payload);
  return {
    argsSummary: input.argsSummary,
    outcome: input.outcome,
    payload: input.payload,
    payloadBytes: Buffer.byteLength(serialised, "utf8"),
    payloadSha256: serialised ? createHash("sha256").update(serialised).digest("hex") : undefined,
    redactions: input.redactions ?? {},
    sessionId: input.sessionId,
    stopId: input.stopId,
    timestamp: now.toISOString(),
    tool: input.tool,
  };
}

export class AuditLog {
  private lastPrunedDay = "";

  public constructor(
    private readonly directory: string,
    private readonly clock: () => Date = (): Date => new Date(),
  ) {}

  public get folder(): string {
    return this.directory;
  }

  public currentFile(): string {
    return path.join(this.directory, auditFileName(this.clock()));
  }

  public async write(input: IAuditInput): Promise<IAuditEntry> {
    const now = this.clock();
    const entry = buildAuditEntry(input, now);
    await mkdir(this.directory, { recursive: true });
    await appendFile(path.join(this.directory, auditFileName(now)), `${JSON.stringify(entry)}\n`, "utf8");
    await this.pruneOncePerDay(now);
    return entry;
  }

  private async pruneOncePerDay(now: Date): Promise<void> {
    const today = auditFileName(now);
    if (this.lastPrunedDay === today) return;
    this.lastPrunedDay = today;
    const expired = expiredAuditFiles(await readdir(this.directory), now);
    await Promise.all(expired.map((name) => unlink(path.join(this.directory, name))));
  }
}
