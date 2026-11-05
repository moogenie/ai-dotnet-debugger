export interface IConsentStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface IConsentRecord {
  grantedAt: string;
  statementVersion: number;
}

export const CONSENT_KEY = "aiDebugger.consent";
export const CONSENT_STATEMENT_VERSION = 1;

export const CONSENT_STATEMENT =
  "AI Debugger lets an AI agent read and step this workspace's local .NET process. " +
  "Use it with test data only: never real customer data, and never a remote, shared or production process. " +
  "Values are redacted and every payload sent to the agent is logged locally.";

// Consent needs a trusted workspace and an explicit opt-in to the current statement.
// A new statement version asks again.
export class WorkspaceConsent {
  public constructor(
    private readonly store: IConsentStore,
    private readonly isWorkspaceTrusted: () => boolean,
  ) {}

  public isGranted(): boolean {
    const record = this.store.get<IConsentRecord>(CONSENT_KEY);
    return this.isWorkspaceTrusted() && record?.statementVersion === CONSENT_STATEMENT_VERSION;
  }

  public async grant(now: Date = new Date()): Promise<void> {
    const record: IConsentRecord = { grantedAt: now.toISOString(), statementVersion: CONSENT_STATEMENT_VERSION };
    await this.store.update(CONSENT_KEY, record);
  }

  public async revoke(): Promise<void> {
    await this.store.update(CONSENT_KEY, undefined);
  }
}
