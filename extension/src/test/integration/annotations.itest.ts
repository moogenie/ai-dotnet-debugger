import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { IAnnotationItem } from "../../journal/webview/journal-protocol";
import { agentDrives, enable, getHarness, repoRoot, stopAll, type IHarness } from "./harness";
import { connectAgent, drain, errorText, headersFromHelper, waitForKind, type IAgent } from "./mcp-agent";

const BASKET = "fixtures/SampleApp/Domain/Basket.cs";
const POLL_MS = 100;
const POLL_ATTEMPTS = 50;

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("inline annotations", () => {
  let harness: IHarness;
  let agent: IAgent;

  function journalNote(id: string): IAnnotationItem | undefined {
    return harness.journal.state().items.find((item): item is IAnnotationItem => item.kind === "annotation" && item.annotation.id === id);
  }

  before(async () => {
    harness = await getHarness();
    await enable();
    await agentDrives();
  });

  beforeEach(async () => {
    agent = await connectAgent(harness.mcp.port ?? 0, await headersFromHelper(harness.mcp.helperCommand()));
    await drain(agent);
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(repoRoot(), BASKET)));
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("aiDebugger.clearAnnotations");
    await agent.close();
    await stopAll();
  });

  it("shows an annotate call on the named line, redacted, and lists it in the Journal", async () => {
    const pinned = await agent.json<{ id: string; line: number; path: string; text: string }>("annotate", {
      line: 25,
      path: BASKET,
      text: "productAmount is 0 here; owner synthetic.user@example.com",
    });
    assert.equal(pinned.text, "productAmount is 0 here; owner [redacted:email]");
    await until(() => harness.annotations.decoratedLines(BASKET).includes(25), "the decoration on line 25");
    assert.deepEqual(harness.annotations.decoratedLines(BASKET), [25]);
    assert.equal(journalNote(pinned.id)?.annotation.line, 25);

    assert.match(errorText(await agent.call("annotate", { line: 1, path: "../outside.cs", text: "x" })), /outside the workspace/);
    assert.match(errorText(await agent.call("annotate", { line: 9999, path: BASKET, text: "x" })), /line 9999 does not exist/);
  });

  it("clears a note the person dismisses, and the agent can clear its own", async () => {
    const first = await agent.json<{ id: string }>("annotate", { line: 24, path: BASKET, text: "net is computed here" });
    const second = await agent.json<{ id: string }>("annotate", { line: 25, path: BASKET, text: "amounts summed here" });
    await vscode.commands.executeCommand("aiDebugger.dismissAnnotation", first.id);
    await until(() => !harness.annotations.decoratedLines(BASKET).includes(24), "line 24 to clear");
    assert.deepEqual(harness.annotations.decoratedLines(BASKET), [25]);
    assert.equal(journalNote(first.id)?.clearedBecause, "the person dismissed it");

    await agent.json("clear_annotations", {});
    await until(() => harness.annotations.decoratedLines(BASKET).length === 0, "all notes to clear");
    assert.equal(journalNote(second.id)?.clearedBecause, "the agent cleared its annotations");
  });

  it("clears every note when the session ends", async () => {
    await agent.json("set_breakpoint", { line: 24, path: BASKET });
    await agent.json("start_session", { name: "SampleApp: discount" });
    const stopped = await waitForKind(agent, "stopped");
    const note = await agent.json<{ id: string }>("annotate", { line: 24, path: BASKET, stopId: stopped.stopId, text: "stopped here" });
    await until(() => harness.annotations.decoratedLines(BASKET).includes(24), "the decoration");
    await agent.json("stop_session");
    await waitForKind(agent, "exited");
    await until(() => harness.annotations.store.list().length === 0, "the notes to clear");
    assert.deepEqual(harness.annotations.decoratedLines(BASKET), []);
    assert.equal(journalNote(note.id)?.clearedBecause, "the session ended");
  });

  it("clears the notes of a file the person edits, so none points at a moved line", async () => {
    const note = await agent.json<{ id: string }>("annotate", { line: 25, path: BASKET, text: "amounts summed here" });
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    try {
      await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "// inserted line\n"));
      await until(() => harness.annotations.store.list().length === 0, "the note to clear");
      assert.equal(journalNote(note.id)?.clearedBecause, "the file was edited");
    } finally {
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
    assert.equal(editor.document.isDirty, false, "the fixture must be left unchanged");
  });
});
