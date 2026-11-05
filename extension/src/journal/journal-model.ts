import type { AnnotationChange } from "../annotations/annotation-store";
import type { ControlRecord } from "../control/control-lock";
import type { SessionEvent } from "../session/session-events";
import type { IProposalItem, IQuestionItem, IStopItem, IStopLocation, JournalItem } from "./webview/journal-protocol";

export const MAX_ITEMS = 200;
export const MAX_NARRATION_CHARS = 2000;

export class NarrationRefusedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NarrationRefusedError";
  }
}

export interface IJournalSnapshot {
  currentStopId?: number;
  items: JournalItem[];
  itemsOmitted: number;
}

export interface IAskedQuestion {
  location?: IStopLocation;
  questionId: number;
  stopId?: number;
}

// The Journal's timeline. Every item comes from a session event, an agent call or the person's own question,
// so the Journal can only show what was reported.
// Holds no VS Code types, so unit tests drive it directly.
export class JournalModel {
  private readonly items: JournalItem[] = [];
  private readonly listeners = new Set<() => void>();
  private currentStop: IStopItem | undefined;
  private lastExitCode: number | undefined;
  private nextId = 1;
  private omitted = 0;

  public constructor(private readonly now: () => Date = (): Date => new Date()) {}

  public get currentStopId(): number | undefined {
    return this.currentStop?.stopId;
  }

  public onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: (): void => void this.listeners.delete(listener) };
  }

  public snapshot(): IJournalSnapshot {
    return { currentStopId: this.currentStopId, items: structuredClone(this.items), itemsOmitted: this.omitted };
  }

  public onSessionEvent(event: SessionEvent): void {
    switch (event.kind) {
      case "started":
        this.currentStop = undefined;
        this.add({ at: this.stamp(), id: this.newId(), kind: "session", name: event.name });
        return;
      case "stopped": {
        const stop: IStopItem = {
          at: this.stamp(),
          id: this.newId(),
          kind: "stop",
          locationState: "pending",
          narrations: [],
          reason: event.reason,
          stopId: event.stopId,
          text: event.text,
        };
        this.currentStop = stop;
        this.add(stop);
        return;
      }
      case "continued": {
        const stop = this.findStop(event.stopId);
        if (stop) {
          stop.resumedBy = event.cause;
          if (stop.locationState === "pending") stop.locationState = "resumed";
        }
        if (this.currentStop?.stopId === event.stopId) this.currentStop = undefined;
        this.changed();
        return;
      }
      case "exited":
        this.lastExitCode = event.exitCode;
        return;
      case "terminated":
        this.currentStop = undefined;
        this.add({ at: this.stamp(), exitCode: this.lastExitCode, id: this.newId(), kind: "exited" });
        this.lastExitCode = undefined;
        return;
      default:
        return;
    }
  }

  // The debugger's answer to the extension's own stack trace request. undefined means it reported no location.
  // A location that arrives after the resume is still true for that stop, so it is kept.
  public setLocation(stopId: number, location: IStopLocation | undefined): void {
    const stop = this.findStop(stopId);
    if (!stop) return;
    if (stop.locationState === "pending") {
      stop.location = location;
      stop.locationState = location ? "reported" : "unavailable";
    } else if (stop.locationState === "resumed" && location) {
      stop.location = location;
      stop.locationState = "reported";
    } else {
      return;
    }
    this.changed();
  }

  // A narration names the stop it is about. If that stop is no longer current, it is refused rather than
  // attached to a stop the agent has not seen. Without a stopId it is a note that is not about a stop.
  // With answers, it is the answer to that question and goes under the question, whatever stop is current now.
  public addNarration(text: string, stopId?: number, answers?: number): { answers?: number; stopId?: number } {
    const trimmed = text.trim();
    if (!trimmed) throw new NarrationRefusedError("The narration is empty.");
    if (trimmed.length > MAX_NARRATION_CHARS) {
      throw new NarrationRefusedError(`The narration is longer than ${MAX_NARRATION_CHARS} characters.`);
    }
    if (answers !== undefined) {
      const question = this.items.find((item): item is IQuestionItem => item.kind === "question" && item.id === answers);
      if (!question) {
        throw new NarrationRefusedError(`Question ${answers} is not in the Journal. Use the questionId from the question event.`);
      }
      question.answers = [...(question.answers ?? []), { at: this.stamp(), text: trimmed }];
      this.changed();
      return { answers, stopId: question.stopId };
    }
    if (stopId === undefined) {
      this.add({ at: this.stamp(), id: this.newId(), kind: "note", text: trimmed });
      return {};
    }
    const current = this.currentStop;
    if (current?.stopId !== stopId) {
      const now = current ? `the current stop is ${current.stopId}` : "the process is not stopped";
      throw new NarrationRefusedError(`Stop ${stopId} is not the current stop: ${now}. Call get_status, then narrate the current stop.`);
    }
    current.narrations.push({ at: this.stamp(), text: trimmed });
    this.changed();
    return { stopId };
  }

  // The person's question carries the stop and location the Journal showed when they asked it.
  public addQuestion(text: string): IAskedQuestion {
    const stop = this.currentStop;
    const question: IQuestionItem = {
      at: this.stamp(),
      id: this.newId(),
      kind: "question",
      location: stop?.location,
      stopId: stop?.stopId,
      text,
    };
    this.add(question);
    return { location: question.location, questionId: question.id, stopId: question.stopId };
  }

  // What the control lock reported: a proposal and its outcome, the person taking or handing back control,
  // or a mode change. A proposal is one item, updated in place as it is decided.
  public recordControl(record: ControlRecord): void {
    if (record.kind === "proposal") {
      const existing = this.items.find(
        (item): item is IProposalItem => item.kind === "proposal" && item.proposal.id === record.proposal.id,
      );
      if (existing) {
        existing.proposal = { ...record.proposal };
        this.changed();
      } else {
        this.add({ at: this.stamp(), id: this.newId(), kind: "proposal", proposal: { ...record.proposal } });
      }
      return;
    }
    if (record.kind === "taken") {
      this.add({ at: this.stamp(), cause: record.cause, change: "taken", id: this.newId(), kind: "control" });
    } else if (record.kind === "handed_back") {
      this.add({ at: this.stamp(), change: "handed_back", id: this.newId(), kind: "control" });
    } else {
      this.add({ at: this.stamp(), change: "mode", id: this.newId(), kind: "control", mode: record.mode });
    }
  }

  // A note the agent pinned to a line, and when and why it went.
  public recordAnnotation(change: AnnotationChange): void {
    if (change.kind === "added") {
      this.add({ annotation: { ...change.annotation }, at: this.stamp(), id: this.newId(), kind: "annotation" });
      return;
    }
    const ids = new Set(change.annotations.map((annotation) => annotation.id));
    for (const item of this.items) {
      if (item.kind === "annotation" && ids.has(item.annotation.id) && !item.clearedAt) {
        item.clearedAt = this.stamp();
        item.clearedBecause = change.reason;
      }
    }
    this.changed();
  }

  public markDelivered(questionId: number): void {
    const question = this.items.find((item): item is IQuestionItem => item.kind === "question" && item.id === questionId);
    if (!question || question.deliveredAt) return;
    question.deliveredAt = this.stamp();
    this.changed();
  }

  public clear(): void {
    // The current stop, any proposal still waiting and any note still shown stay, so nothing live disappears.
    const kept = this.items.filter(
      (item) =>
        item === this.currentStop ||
        (item.kind === "proposal" && item.proposal.status === "pending") ||
        (item.kind === "annotation" && !item.clearedAt),
    );
    this.items.splice(0, this.items.length, ...kept);
    this.omitted = 0;
    this.changed();
  }

  private add(item: JournalItem): void {
    this.items.push(item);
    while (this.items.length > MAX_ITEMS) {
      this.items.shift();
      this.omitted++;
    }
    this.changed();
  }

  private findStop(stopId: number): IStopItem | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item?.kind === "stop" && item.stopId === stopId) return item;
    }
    return undefined;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private newId(): number {
    return this.nextId++;
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}
