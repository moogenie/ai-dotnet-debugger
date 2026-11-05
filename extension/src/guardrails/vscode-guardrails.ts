import * as path from "node:path";
import * as vscode from "vscode";
import { AuditLog } from "./audit-log";
import type { EvaluationMode } from "../session/snapshot.types";
import type { IApprover } from "./agent-gateway";
import { Redactor, parseAdditionalRules, type IAdditionalRuleSetting } from "./redaction";
import { CONSENT_STATEMENT, WorkspaceConsent } from "./workspace-consent";

const ENABLE_CHOICE = "Enable for this workspace";
const ADDITIONAL_RULES_SETTING = "redaction.additionalRules";

const RUN_UNDER_NSE = "Run under nse";
const RUN_FOR_REAL = "Run for real";

export class ModalApprover implements IApprover {
  public async approveEvaluate(expression: string, reason: string): Promise<EvaluationMode | undefined> {
    const choice = await vscode.window.showWarningMessage(
      `The agent wants to evaluate '${expression}', which ${reason}.`,
      {
        detail:
          "Run under nse: no side effects, but the nse interpreter can return a wrong value without an error " +
          "(it was seen to compute a decimal times 1 as 0).\n" +
          "Run for real: the value is exact, but the code really runs and can change program state.",
        modal: true,
      },
      RUN_UNDER_NSE,
      RUN_FOR_REAL,
    );
    if (choice === RUN_UNDER_NSE) return "nse";
    if (choice === RUN_FOR_REAL) return "real";
    return undefined;
  }
}

export function currentRedactor(): Redactor {
  const settings = vscode.workspace
    .getConfiguration("aiDebugger")
    .get<IAdditionalRuleSetting[]>(ADDITIONAL_RULES_SETTING, []);
  const { invalid, rules } = parseAdditionalRules(Array.isArray(settings) ? settings : []);
  if (invalid.length > 0) {
    void vscode.window.showWarningMessage(
      `AI Debugger ignored invalid redaction rules: ${invalid.join(", ")}. The built-in rules still apply.`,
    );
  }
  return new Redactor(rules);
}

export function createAuditLog(context: vscode.ExtensionContext): AuditLog {
  return new AuditLog(path.join(context.globalStorageUri.fsPath, "audit"));
}

export function createConsent(context: vscode.ExtensionContext): WorkspaceConsent {
  return new WorkspaceConsent(context.workspaceState, () => vscode.workspace.isTrusted);
}

export function registerGuardrailCommands(
  consent: WorkspaceConsent,
  audit: AuditLog,
  onConsentChanged: () => Promise<void>,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("aiDebugger.enableForWorkspace", async (): Promise<void> => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showErrorMessage("AI Debugger only works in a trusted workspace.");
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        "Enable AI Debugger for this workspace?",
        { detail: CONSENT_STATEMENT, modal: true },
        ENABLE_CHOICE,
      );
      if (choice !== ENABLE_CHOICE) return;
      await consent.grant();
      await onConsentChanged();
    }),
    vscode.commands.registerCommand("aiDebugger.disableForWorkspace", async (): Promise<void> => {
      await consent.revoke();
      await onConsentChanged();
      void vscode.window.showInformationMessage("AI Debugger is disabled for this workspace.");
    }),
    vscode.commands.registerCommand("aiDebugger.openAuditLog", async (): Promise<void> => {
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(audit.currentFile()));
      } catch {
        void vscode.window.showInformationMessage(`No audit entries today. The audit folder is ${audit.folder}.`);
      }
    }),
  ];
}
