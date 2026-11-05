import { describe, expect, it } from "vitest";
import { AnnotationRefusedError, AnnotationStore, MAX_ANNOTATIONS, MAX_ANNOTATION_CHARS, type AnnotationChange } from "./annotation-store";

const BASKET = "fixtures/SampleApp/Domain/Basket.cs";

function setUp(): { changes: AnnotationChange[]; store: AnnotationStore } {
  const store = new AnnotationStore(() => new Date(Date.UTC(2026, 9, 22, 9, 0, 0)));
  const changes: AnnotationChange[] = [];
  store.onDidChange((change) => changes.push(change));
  return { changes, store };
}

describe("AnnotationStore", () => {
  it("pins a trimmed note with a new id and reports it", () => {
    const { changes, store } = setUp();
    const pinned = store.add({ line: 25, path: BASKET, stopId: 2, text: "  productAmount is 0 here  " });
    expect(pinned).toEqual({ at: "2026-10-22T09:00:00.000Z", id: "a1", line: 25, path: BASKET, stopId: 2, text: "productAmount is 0 here" });
    expect(store.list()).toEqual([pinned]);
    expect(changes).toEqual([{ annotation: pinned, kind: "added" }]);
  });

  it.each(["", "   ", "x".repeat(MAX_ANNOTATION_CHARS + 1)])("refuses an empty or oversized note", (text) => {
    const { store } = setUp();
    expect(() => store.add({ line: 1, path: BASKET, text })).toThrow(AnnotationRefusedError);
    expect(store.list()).toEqual([]);
  });

  it("refuses more than the limit", () => {
    const { store } = setUp();
    for (let i = 0; i < MAX_ANNOTATIONS; i++) store.add({ line: 1, path: BASKET, text: `note ${i}` });
    expect(() => store.add({ line: 1, path: BASKET, text: "one more" })).toThrow(/clear_annotations/);
  });

  it("removes one note by id, or all, and says why", () => {
    const { changes, store } = setUp();
    store.add({ line: 24, path: BASKET, text: "a" });
    store.add({ line: 25, path: BASKET, text: "b" });
    store.add({ line: 3, path: "other.cs", text: "c" });
    expect(store.clear("the person dismissed it", "a2").map((annotation) => annotation.id)).toEqual(["a2"]);
    expect(store.clear("the session ended").map((annotation) => annotation.id)).toEqual(["a1", "a3"]);
    expect(store.list()).toEqual([]);
    expect(changes.filter((change) => change.kind === "cleared").map((change) => change.kind === "cleared" && change.reason)).toEqual([
      "the person dismissed it",
      "the session ended",
    ]);
  });

  it("refuses to clear an id that is not active, and reports nothing when there is nothing to clear", () => {
    const { changes, store } = setUp();
    expect(() => store.clear("x", "a7")).toThrow(/not an active annotation/);
    expect(store.clear("the session ended")).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("clears only the notes of a file that was edited", () => {
    const { store } = setUp();
    store.add({ line: 24, path: BASKET, text: "a" });
    store.add({ line: 3, path: "other.cs", text: "b" });
    store.clearFile(BASKET, "the file was edited");
    expect(store.list().map((annotation) => annotation.path)).toEqual(["other.cs"]);
  });

  it("hands out copies", () => {
    const { store } = setUp();
    const pinned = store.add({ line: 1, path: BASKET, text: "a" });
    pinned.text = "forged";
    (store.list()[0] as { text: string }).text = "forged";
    expect(store.list()[0]?.text).toBe("a");
  });
});
