// A control request reached the debug adapter that the extension did not send: the person pressed a debug control.
export interface IPersonControlEvent {
  command: string;
  kind: "person-control";
}

export interface IStartedEvent {
  kind: "started";
  name: string;
  sessionId: string;
}

export interface IStoppedEvent {
  kind: "stopped";
  reason: string;
  stopId: number;
  text?: string;
  threadId?: number;
}

export interface IContinuedEvent {
  cause: string;
  kind: "continued";
  stopId: number;
  threadId?: number;
}

export interface IExceptionEvent {
  kind: "exception";
  stopId: number;
  text?: string;
  threadId?: number;
}

export interface IOutputEvent {
  category: string;
  kind: "output";
  text: string;
}

export interface IExitedEvent {
  exitCode: number;
  kind: "exited";
}

export interface ITerminatedEvent {
  kind: "terminated";
}

export type SessionEvent =
  | IContinuedEvent
  | IExceptionEvent
  | IExitedEvent
  | IOutputEvent
  | IPersonControlEvent
  | IStartedEvent
  | IStoppedEvent
  | ITerminatedEvent;

export type SessionEventListener = (event: SessionEvent) => void;

export interface IDisposable {
  dispose(): void;
}

export class SessionEventBus {
  private readonly listeners = new Set<SessionEventListener>();

  public subscribe(listener: SessionEventListener): IDisposable {
    this.listeners.add(listener);
    return { dispose: (): void => void this.listeners.delete(listener) };
  }

  public publish(event: SessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
