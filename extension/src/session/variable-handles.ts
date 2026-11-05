export class StaleHandleError extends Error {
  public constructor(handle: string) {
    super(`Handle ${handle} belongs to an earlier stop. The process has resumed since, so read a new snapshot.`);
    this.name = "StaleHandleError";
  }
}

export class UnknownHandleError extends Error {
  public constructor(handle: string) {
    super(`Handle ${handle} is not known.`);
    this.name = "UnknownHandleError";
  }
}

const HANDLE_PATTERN = /^h(\d+)\.(\d+)$/;

// Opaque handles stand in for DAP variable references, which the adapter invalidates on every resume.
export class VariableHandles {
  private readonly references = new Map<string, number>();
  private stopId = 0;
  private next = 0;

  // Handles reset only when the stop changes, so handles from an evaluate survive a later snapshot.
  public ensureStop(stopId: number): void {
    if (stopId === this.stopId) return;
    this.stopId = stopId;
    this.next = 0;
    this.references.clear();
  }

  public register(variablesReference: number): string {
    this.next++;
    const handle = `h${this.stopId}.${this.next}`;
    this.references.set(handle, variablesReference);
    return handle;
  }

  public resolve(handle: string, currentStopId: number | undefined): number {
    const match = HANDLE_PATTERN.exec(handle);
    if (!match) throw new UnknownHandleError(handle);
    if (Number(match[1]) !== currentStopId || Number(match[1]) !== this.stopId) {
      throw new StaleHandleError(handle);
    }
    const reference = this.references.get(handle);
    if (reference === undefined) throw new UnknownHandleError(handle);
    return reference;
  }
}
