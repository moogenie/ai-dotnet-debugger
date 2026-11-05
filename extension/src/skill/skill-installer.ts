import { copyFile, mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { SKILL_FILE, SKILL_NAME, userSkillFolder } from "./skill-paths";

const INSTALL_CHOICE = "Install";

// Copies the debug-pair skill shipped in the .vsix into the person's Claude Code skills, so it works in any
// repository, not only this one. It asks first, and says when it would replace a different copy.
export class SkillInstaller {
  public constructor(private readonly extensionUri: vscode.Uri) {}

  public registerCommands(): vscode.Disposable[] {
    return [vscode.commands.registerCommand("aiDebugger.installSkill", () => this.install())];
  }

  public async install(): Promise<boolean> {
    const source = path.join(this.extensionUri.fsPath, "dist", "skills", SKILL_NAME, SKILL_FILE);
    const target = path.join(userSkillFolder(), SKILL_FILE);
    const shipped = await readFile(source, "utf8");
    const existing = await readFile(target, "utf8").catch(() => undefined);
    if (existing === shipped) {
      void vscode.window.showInformationMessage(`The debug-pair skill is already installed at ${target}.`);
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      "Install the debug-pair skill for Claude Code?",
      {
        detail:
          `This copies the skill to ${target}, so Claude Code can use it in any repository.` +
          (existing === undefined ? "" : " A different copy is there now, and it will be replaced."),
        modal: true,
      },
      INSTALL_CHOICE,
    );
    if (choice !== INSTALL_CHOICE) return false;
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    void vscode.window.showInformationMessage("The debug-pair skill is installed. Start a new Claude Code session to use it.");
    return true;
  }
}
