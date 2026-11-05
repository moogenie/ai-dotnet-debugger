// Probe for the DAP read spike. Runs inside a VS Code extension host.
// It drives the real coreclr debugger through the public API and records what it observes.
// Throwaway spike code: it favours a complete record over structure.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const CONTROL_COMMANDS = new Set(["next", "stepIn", "stepOut", "continue", "pause"]);
const STOP_TIMEOUT_MS = 120000;

const messages = [];
const output = [];
const pendingFromExtension = [];
const startAttempts = [];
let stopWaiters = [];
let endWaiters = [];

function now() {
  return new Date().toISOString();
}

vscode.debug.registerDebugAdapterTrackerFactory("coreclr", {
  createDebugAdapterTracker() {
    return {
      onWillReceiveMessage(m) {
        let origin;
        if (m.type === "request" && CONTROL_COMMANDS.has(m.command)) {
          const i = pendingFromExtension.indexOf(m.command);
          if (i >= 0) {
            pendingFromExtension.splice(i, 1);
            origin = "extension";
          } else {
            origin = "not-extension";
          }
        }
        messages.push({ t: now(), dir: "to-adapter", type: m.type, command: m.command, seq: m.seq, origin });
      },
      onDidSendMessage(m) {
        const entry = { t: now(), dir: "from-adapter", type: m.type, command: m.command, event: m.event };
        if (m.type === "event" && ["stopped", "exited", "terminated"].includes(m.event)) entry.body = m.body;
        messages.push(entry);
        if (m.type === "event" && m.event === "output") output.push(m.body.output);
        if (m.type === "event" && m.event === "stopped") {
          const w = stopWaiters;
          stopWaiters = [];
          w.forEach((resolve) => resolve(m.body));
        }
        if (m.type === "event" && (m.event === "terminated" || m.event === "exited")) {
          const w = endWaiters;
          endWaiters = [];
          w.forEach((resolve) => resolve(m.body));
        }
      },
    };
  },
});

function waitFor(list, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), STOP_TIMEOUT_MS);
    const done = (body) => {
      clearTimeout(timer);
      resolve(body);
    };
    if (list === "stop") stopWaiters.push(done);
    else endWaiters.push(done);
  });
}

async function safe(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function launchConfig(root, name) {
  const all = vscode.workspace.getConfiguration("launch", vscode.Uri.file(root)).get("configurations") || [];
  const found = all.find((c) => c.name === name);
  if (!found) throw new Error(`launch configuration not found: ${name}`);
  const copy = { ...found };
  delete copy.preLaunchTask; // run.js builds the app first
  return copy;
}

async function startAndStop(folder, config, breakpointFile, breakpointLine) {
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  if (breakpointFile) {
    const uri = vscode.Uri.file(breakpointFile);
    vscode.debug.addBreakpoints([
      new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(breakpointLine - 1, 0))),
    ]);
  }
  const stopped = waitFor("stop", `first stop in ${config.name}`);
  // On a first run the C# extension downloads its debugger before it registers the coreclr adapter.
  let started = false;
  for (let attempt = 1; attempt <= 24 && !started; attempt++) {
    try {
      started = await vscode.debug.startDebugging(folder, config);
    } catch (err) {
      if (!/debug adapter descriptor/i.test(String(err && err.message))) throw err;
      startAttempts.push({ t: now(), config: config.name, attempt, error: "coreclr adapter not registered yet" });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!started) throw new Error(`startDebugging did not start ${config.name}`);
  const body = await stopped;
  return { session: vscode.debug.activeDebugSession, stopped: body };
}

async function readFrame(session, threadId) {
  const stack = await session.customRequest("stackTrace", { threadId, startFrame: 0, levels: 20 });
  const top = stack.stackFrames[0];
  const scopes = await session.customRequest("scopes", { frameId: top.id });
  const scopeVars = [];
  for (const scope of scopes.scopes) {
    const vars = await session.customRequest("variables", { variablesReference: scope.variablesReference });
    scopeVars.push({ scope: scope.name, variables: vars.variables });
  }
  return { stack, top, scopes: scopes.scopes, scopeVars };
}

function field(frameId, session, expression) {
  return safe(() => session.customRequest("evaluate", { expression, frameId, context: "watch" }));
}

async function finish(session, threadId) {
  const ended = waitFor("end", "session end");
  pendingFromExtension.push("continue");
  await safe(() => session.customRequest("continue", { threadId }));
  await Promise.race([ended, new Promise((r) => setTimeout(r, 15000))]);
  await new Promise((r) => setTimeout(r, 1000));
}

function summaryLine(fromIndex) {
  return output.slice(fromIndex).join("").split(/\r?\n/).find((l) => l.startsWith("Summary reads:")) || null;
}

async function getterRun(folder, root, configName, withControlProof, evalOverride) {
  const record = { config: configName };
  const outStart = output.length;
  const basket = path.join(root, "fixtures", "SampleApp", "Domain", "Basket.cs");
  const config = launchConfig(root, configName);
  if (evalOverride) {
    config.expressionEvaluationOptions = { ...(config.expressionEvaluationOptions || {}), ...evalOverride };
    config.name = `${configName} + ${JSON.stringify(evalOverride)}`;
    record.config = config.name;
  }
  const { session, stopped } = await startAndStop(folder, config, basket, 24);
  record.stopped = stopped;
  const frame = await readFrame(session, stopped.threadId);
  record.top = { name: frame.top.name, line: frame.top.line, source: frame.top.source && frame.top.source.path };
  record.stackDepth = frame.stack.stackFrames.length;
  record.scopes = frame.scopeVars.map((s) => ({
    scope: s.scope,
    variables: s.variables.map((v) => ({ name: v.name, type: v.type, value: v.value, presentationHint: v.presentationHint })),
  }));

  const frameId = frame.top.id;
  record.counterBefore = await field(frameId, session, "this._summaryReads");

  const thisVar = frame.scopeVars.flatMap((s) => s.variables).find((v) => v.name.split(" [")[0] === "this");
  if (thisVar && thisVar.variablesReference) {
    const children = await session.customRequest("variables", { variablesReference: thisVar.variablesReference });
    record.thisChildren = children.variables.map((v) => ({
      name: v.name,
      type: v.type,
      value: v.value,
      presentationHint: v.presentationHint,
      evaluateName: v.evaluateName,
    }));
    // Non-public members are often nested one level down.
    const nonPublic = children.variables.find((v) => /non-public/i.test(v.name));
    if (nonPublic && nonPublic.variablesReference) {
      const np = await session.customRequest("variables", { variablesReference: nonPublic.variablesReference });
      record.thisNonPublic = np.variables.map((v) => ({
        name: v.name,
        type: v.type,
        value: v.value,
        presentationHint: v.presentationHint,
      }));
    }
  }
  record.counterAfterExpand = await field(frameId, session, "this._summaryReads");

  // Can the agent see inside a collection? Expand lines, then its first element.
  const allLocals = frame.scopeVars.flatMap((s) => s.variables);
  // vsdbg appends the declared type to some names, for example "lines [IReadOnlyList]".
  const linesVar = allLocals.find((v) => v.name.split(" [")[0] === "lines");
  if (linesVar && linesVar.variablesReference) {
    const items = await session.customRequest("variables", { variablesReference: linesVar.variablesReference });
    record.linesChildren = items.variables.map((v) => ({ name: v.name, value: v.value, presentationHint: v.presentationHint }));
    const first = items.variables.find((v) => v.variablesReference && /^\[0\]/.test(v.name));
    const rawView = items.variables.find((v) => /raw view/i.test(v.name));
    const target = first || rawView;
    if (target) {
      const inner = await session.customRequest("variables", { variablesReference: target.variablesReference });
      record.linesInner = { via: target.name, children: inner.variables.map((v) => ({ name: v.name, value: v.value, presentationHint: v.presentationHint })) };
    }
  }
  // With implicit evaluation off, follow fields only: Raw View -> Non-Public members -> _items -> [0] -> backing fields.
  if (linesVar && linesVar.variablesReference) {
    const path = [];
    const step = async (ref, pick, label) => {
      const res = await session.customRequest("variables", { variablesReference: ref });
      const names = res.variables.map((v) => `${v.name}=${v.value} kind=${v.presentationHint && v.presentationHint.kind}`);
      path.push({ at: label, children: names });
      return res.variables.find(pick);
    };
    const base = (v) => v.name.split(" [")[0];
    // Walk fields only. Each wanted hop is optional, because showRawValues removes the Raw View layer.
    const hops = [
      (v) => /raw view/i.test(v.name),
      (v) => /non-public/i.test(v.name),
      (v) => base(v) === "_items",
      (v) => base(v) === "[0]",
      (v) => /non-public/i.test(v.name),
    ];
    let ref = linesVar.variablesReference;
    let label = "lines";
    for (let depth = 0; depth < 8 && ref; depth++) {
      const res = await session.customRequest("variables", { variablesReference: ref });
      path.push({ at: label, children: res.variables.map((v) => `${v.name}=${v.value} kind=${v.presentationHint && v.presentationHint.kind}`) });
      let next = null;
      while (hops.length && !next) {
        next = res.variables.find(hops[0]) || null;
        hops.shift();
      }
      ref = next ? next.variablesReference : 0;
      label = next ? next.name : "";
    }
    record.fieldPath = path;
    record.backingFieldEvaluate = await field(frameId, session, "this.lines");
  }
  record.counterAfterLines = await field(frameId, session, "this._summaryReads");

  // Does the evaluate context change what runs?
  record.contexts = [];
  for (const context of ["repl", "hover", "clipboard", "variables"]) {
    const r = await safe(() => session.customRequest("evaluate", { expression: "this.Summary", frameId, context }));
    const after = await field(frameId, session, "this._summaryReads");
    record.contexts.push({ context, result: r.ok ? r.value.result : "ERR: " + r.error, counterAfter: after.ok ? after.value.result : "ERR" });
  }
  record.methodCall = await safe(() => session.customRequest("evaluate", { expression: "this.Calculate(3).Amount", frameId, context: "repl" }));
  record.counterAfterContexts = await field(frameId, session, "this._summaryReads");

  // Does nse carry through to children? Evaluate roots with nse, then expand by variablesReference.
  const nseTree = async (expression, depth) => {
    const root = await safe(() => session.customRequest("evaluate", { expression, frameId, context: "watch" }));
    if (!root.ok) return { expression, error: root.error };
    const out = { expression, result: root.value.result, children: [] };
    const walk = async (ref, level, into) => {
      if (!ref || level > depth) return;
      const res = await session.customRequest("variables", { variablesReference: ref });
      for (const v of res.variables) {
        const node = { name: v.name, value: v.value, evaluateName: v.evaluateName, children: [] };
        into.push(node);
        if (v.variablesReference && /^\[[0-1]\]/.test(v.name)) await walk(v.variablesReference, level + 1, node.children);
      }
    };
    await walk(root.value.variablesReference, 1, out.children);
    return out;
  };
  const counterPreNse = await field(frameId, session, "this._summaryReads");
  record.nseThis = await nseTree("this, nse", 1);
  record.counterAfterNseThis = await field(frameId, session, "this._summaryReads");
  record.nseLines = await nseTree("lines, nse", 2);
  record.counterAfterNseLines = await field(frameId, session, "this._summaryReads");
  record.counterPreNse = counterPreNse;
  record.nseEvaluate = await field(frameId, session, "this.Summary, nse");
  record.counterAfterNse = await field(frameId, session, "this._summaryReads");

  record.explicitEvaluate = await field(frameId, session, "this.Summary");
  record.counterAfterExplicit = await field(frameId, session, "this._summaryReads");

  if (withControlProof) {
    const before = messages.length;
    const s1 = waitFor("stop", "extension step");
    pendingFromExtension.push("next");
    await session.customRequest("next", { threadId: stopped.threadId });
    await s1;
    const s2 = waitFor("stop", "UI step");
    await vscode.commands.executeCommand("workbench.action.debug.stepOver");
    await s2;
    record.controlProof = messages
      .slice(before)
      .filter((m) => m.dir === "to-adapter" && m.type === "request" && CONTROL_COMMANDS.has(m.command));
  }

  await finish(session, stopped.threadId);
  record.finalSummaryLine = summaryLine(outStart);
  return record;
}

async function exceptionRun(folder, root) {
  const record = { config: "SampleApp: refund" };
  const { session, stopped } = await startAndStop(folder, launchConfig(root, "SampleApp: refund"), null, 0);
  record.stopped = stopped;
  record.exceptionInfo = await safe(() => session.customRequest("exceptionInfo", { threadId: stopped.threadId }));
  const frame = await readFrame(session, stopped.threadId);
  record.top = { name: frame.top.name, line: frame.top.line };
  record.supplier = await field(frame.top.id, session, "product.Supplier");
  record.isDiscontinued = await field(frame.top.id, session, "product.IsDiscontinued");
  await safe(() => vscode.debug.stopDebugging(session));
  await new Promise((r) => setTimeout(r, 2000));
  return record;
}

exports.run = async function run() {
  const folder = vscode.workspace.workspaceFolders[0];
  const root = folder.uri.fsPath;
  const csharp = vscode.extensions.getExtension("ms-dotnettools.csharp");
  let csharpExports = null;
  if (csharp) csharpExports = await csharp.activate();
  const initStart = Date.now();
  if (csharpExports && typeof csharpExports.initializationFinished === "function") {
    await csharpExports.initializationFinished();
  }
  const csharpInitMs = Date.now() - initStart;

  const results = {
    startedAt: now(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    vscodeVersion: vscode.version,
    csharpVersion: csharp ? csharp.packageJSON.version : null,
    csharpExportKeys: csharpExports ? Object.keys(csharpExports) : null,
    csharpInitMs,
    runs: {},
  };
  try {
    results.runs.funcEvalOn = await getterRun(folder, root, "SampleApp: discount", false);
    results.runs.funcEvalOff = await getterRun(folder, root, "SampleApp: discount (no implicit func-eval)", true);
    results.runs.funcEvalOffRaw = await getterRun(folder, root, "SampleApp: discount (no implicit func-eval)", false, { showRawValues: true });
    results.runs.exception = await exceptionRun(folder, root);
  } catch (err) {
    results.error = String(err && err.stack ? err.stack : err);
  }
  results.finishedAt = now();
  results.messageCount = messages.length;
  results.startAttempts = startAttempts;

  const outDir = path.join(root, "spikes", "dap-read", "results");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `results-${os.platform()}.json`);
  // The kept results name the repository as <repo>, so they carry no local path.
  const rootPattern = new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const withoutRoot = (key, value) => (typeof value === "string" ? value.replace(rootPattern, "<repo>") : value);
  fs.writeFileSync(file, JSON.stringify(results, withoutRoot, 2) + "\n");
  fs.writeFileSync(path.join(outDir, `messages-${os.platform()}.json`), JSON.stringify(messages, null, 2) + "\n");
  console.log(`spike results written to ${file}`);
  if (results.error) throw new Error(results.error);
};
