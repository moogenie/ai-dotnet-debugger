import type { IAnnotationView } from "../journal/webview/journal-protocol";

export const MAX_ANNOTATIONS = 50;
export const MAX_ANNOTATION_CHARS = 300;

export class AnnotationRefusedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnnotationRefusedError";
  }
}

export interface IAnnotationInput {
  line: number;
  path: string;
  stopId?: number;
  text: string;
}

// What the editor and the Journal hear: a note was pinned, or notes were removed and why.
export type AnnotationChange =
  | { annotation: IAnnotationView; kind: "added" }
  | { annotations: IAnnotationView[]; kind: "cleared"; reason: string };

// The agent's notes pinned to lines. Holds no VS Code types, so unit tests drive it directly.
// Paths are workspace-relative with forward slashes. Lines are 1-based.
export class AnnotationStore {
  private readonly active: IAnnotationView[] = [];
  private readonly listeners = new Set<(change: AnnotationChange) => void>();
  private nextId = 0;

  public constructor(private readonly now: () => Date = (): Date => new Date()) {}

  public onDidChange(listener: (change: AnnotationChange) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: (): void => void this.listeners.delete(listener) };
  }

  public list(): IAnnotationView[] {
    return this.active.map((annotation) => ({ ...annotation }));
  }

  public add(input: IAnnotationInput): IAnnotationView {
    const text = input.text.trim();
    if (!text) throw new AnnotationRefusedError("The annotation is empty.");
    if (text.length > MAX_ANNOTATION_CHARS) {
      throw new AnnotationRefusedError(`The annotation is longer than ${MAX_ANNOTATION_CHARS} characters. Use narrate for longer notes.`);
    }
    if (this.active.length >= MAX_ANNOTATIONS) {
      throw new AnnotationRefusedError(`There are already ${MAX_ANNOTATIONS} annotations. Call clear_annotations first.`);
    }
    this.nextId++;
    const annotation: IAnnotationView = {
      at: this.now().toISOString(),
      id: `a${this.nextId}`,
      line: input.line,
      path: input.path,
      stopId: input.stopId,
      text,
    };
    this.active.push(annotation);
    this.emit({ annotation: { ...annotation }, kind: "added" });
    return { ...annotation };
  }

  // Removes one note, or every note when id is undefined. Returns what it removed.
  public clear(reason: string, id?: string): IAnnotationView[] {
    if (id !== undefined && !this.active.some((annotation) => annotation.id === id)) {
      throw new AnnotationRefusedError(`'${id}' is not an active annotation.`);
    }
    return this.remove((annotation) => id === undefined || annotation.id === id, reason);
  }

  // A file changed, so its line numbers may no longer point where the agent meant.
  public clearFile(path: string, reason: string): IAnnotationView[] {
    return this.remove((annotation) => annotation.path === path, reason);
  }

  private remove(matches: (annotation: IAnnotationView) => boolean, reason: string): IAnnotationView[] {
    const removed = this.active.filter(matches);
    if (removed.length === 0) return [];
    const kept = this.active.filter((annotation) => !matches(annotation));
    this.active.splice(0, this.active.length, ...kept);
    this.emit({ annotations: removed.map((annotation) => ({ ...annotation })), kind: "cleared", reason });
    return removed;
  }

  private emit(change: AnnotationChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
