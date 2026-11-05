import { describe, expect, it } from "vitest";
import { CONSENT_KEY, CONSENT_STATEMENT_VERSION, WorkspaceConsent, type IConsentStore } from "./workspace-consent";

function memoryStore(initial: Record<string, unknown> = {}): IConsentStore {
  const values = new Map(Object.entries(initial));
  return {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: (key: string, value: unknown): Promise<void> => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

describe("WorkspaceConsent", () => {
  it("should not be granted before the person opts in", () => {
    expect(new WorkspaceConsent(memoryStore(), () => true).isGranted()).toBe(false);
  });

  it("should be granted after the person opts in, and not after they revoke", async () => {
    const consent = new WorkspaceConsent(memoryStore(), () => true);
    await consent.grant();
    expect(consent.isGranted()).toBe(true);
    await consent.revoke();
    expect(consent.isGranted()).toBe(false);
  });

  it("should not be granted in an untrusted workspace, even after opt-in", async () => {
    const consent = new WorkspaceConsent(memoryStore(), () => false);
    await consent.grant();
    expect(consent.isGranted()).toBe(false);
  });

  it("should ask again when the statement changes", () => {
    const store = memoryStore({ [CONSENT_KEY]: { grantedAt: "x", statementVersion: CONSENT_STATEMENT_VERSION - 1 } });
    expect(new WorkspaceConsent(store, () => true).isGranted()).toBe(false);
  });
});
