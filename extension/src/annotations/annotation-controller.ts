import * as vscode from "vscode";
import { checkLine, resolveWorkspaceFile, workspaceRelative } from "../control/agent-control";
import type { IAnnotationSink } from "../guardrails/agent-gateway";
import type { IAnnotationView } from "../journal/webview/journal-protocol";
import type { SessionEvent } from "../session/session-events";
import { AnnotationRefusedError, AnnotationStore, type IAnnotationInput } from "./annotation-store";

const DISMISS_COMMAND = "aiDebugger.dismissAnnotation";
const INLINE_CHARS = 80;

export interface IAnnotationSessions {
  onEvent(listener: (event: SessionEvent) => void): { dispose(): void };
}

// Shows the agent's notes at the end of their lines, in every editor that shows the file.
// A note goes when the session ends, when the person dismisses it, or when its file is edited,
// so it never points at a line that has moved.
export class AnnotationController implements IAnnotationSink, vscode.Disposable {
  public readonly store = new AnnotationStore();
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      fontStyle: "italic",
      margin: "0 0 0 2em",
    },
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private readonly applied = new Map<string, number[]>();
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(sessions: IAnnotationSessions) {
    this.disposables.push(
      this.decoration,
      this.store.onDidChange(() => this.render()),
      sessions.onEvent((event) => {
        if (event.kind === "terminated") this.store.clear("the session ended");
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
      vscode.workspace.onDidChangeTextDocument(({ contentChanges, document }) => {
        const path = this.relative(document.uri);
        if (contentChanges.length > 0 && path !== undefined) this.store.clearFile(path, "the file was edited");
      }),
    );
  }

  // The lines that carry a note in each visible editor, by workspace-relative path. Integration tests read it.
  public decoratedLines(path: string): number[] {
    return this.applied.get(path) ?? [];
  }

  public async annotate(input: IAnnotationInput): Promise<IAnnotationView> {
    checkLine(input.line);
    const root = this.root();
    const file = resolveWorkspaceFile(root, input.path);
    let lineCount: number;
    try {
      lineCount = (await vscode.workspace.openTextDocument(vscode.Uri.file(file))).lineCount;
    } catch {
      throw new AnnotationRefusedError(`'${input.path}' is not a file in the workspace.`);
    }
    if (input.line > lineCount) throw new AnnotationRefusedError(`'${input.path}' has ${lineCount} lines, so line ${input.line} does not exist.`);
    return this.store.add({ ...input, path: workspaceRelative(root, file) });
  }

  public clear(id?: string): IAnnotationView[] {
    return this.store.clear(id === undefined ? "the agent cleared its annotations" : "the agent cleared it", id);
  }

  public registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand(DISMISS_COMMAND, (id: string) => {
        if (this.store.list().some((annotation) => annotation.id === id)) this.store.clear("the person dismissed it", id);
      }),
      vscode.commands.registerCommand("aiDebugger.clearAnnotations", () => this.store.clear("the person cleared all annotations")),
    ];
  }

  public dispose(): void {
    this.disposables.forEach((disposable) => void disposable.dispose());
  }

  private render(): void {
    const annotations = this.store.list();
    this.applied.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      const path = this.relative(editor.document.uri);
      if (path === undefined) continue;
      const mine = annotations.filter((annotation) => annotation.path === path && annotation.line <= editor.document.lineCount);
      editor.setDecorations(this.decoration, mine.map((annotation) => this.toDecoration(annotation)));
      if (mine.length > 0) this.applied.set(path, [...(this.applied.get(path) ?? []), ...mine.map((annotation) => annotation.line)]);
    }
  }

  private toDecoration(annotation: IAnnotationView): vscode.DecorationOptions {
    const inline = annotation.text.length > INLINE_CHARS ? `${annotation.text.slice(0, INLINE_CHARS - 1)}…` : annotation.text;
    // The note is model output, so it goes in as escaped text. Only the dismiss command may run from the hover.
    const hover = new vscode.MarkdownString();
    hover.appendText(`AI Debugger agent note${annotation.stopId === undefined ? "" : ` (stop ${annotation.stopId})`}: `);
    hover.appendText(annotation.text);
    hover.appendMarkdown(`\n\n[Dismiss](command:${DISMISS_COMMAND}?${encodeURIComponent(JSON.stringify([annotation.id]))})`);
    hover.isTrusted = { enabledCommands: [DISMISS_COMMAND] };
    const line = annotation.line - 1;
    return {
      hoverMessage: hover,
      range: new vscode.Range(line, 0, line, 0),
      renderOptions: { after: { contentText: `  ◆ ${inline}` } },
    };
  }

  // Only files in the workspace can carry a note. Output channels and untitled documents cannot.
  private relative(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (uri.scheme !== "file" || !folder) return undefined;
    return workspaceRelative(folder.uri.fsPath, uri.fsPath);
  }

  private root(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new AnnotationRefusedError("Open the project folder in VS Code first.");
    return folder.uri.fsPath;
  }
}
