# Delivery brief: ai-dotnet-debugger

## Purpose

A VS Code extension that lets an AI agent run a local debugging session alongside a person.

The agent drives the real VS Code debugger. It places breakpoints, steps, and reads the stack, locals and watch results. The person sees every move in the normal debug UI. Either side can take control at any point.

At each stop, the agent explains what it sees in plain language. The person can ask questions about that exact frame. The agent forms hypotheses, gathers evidence and reports likely issues. This is the way a developer debugged before AI, with a second pair of eyes that reads and reports.

## Shape

The diagram below is the summary. `extension/README.md` lists the tools.

```
 Claude Code (terminal or VS Code panel)  <-- chat with the person
        |  MCP (loopback only, token-protected)
        v
 +------------ VS Code extension: ai-dotnet-debugger -------------+
 |  MCP server     start_session, set_breakpoint, continue, step, |
 |                 wait_for_event, get_snapshot, get_variables,   |
 |                 evaluate, get_output, narrate, annotate        |
 |  Session core   snapshot model, event bus, control lock        |
 |  Guardrails     redaction, safe evaluate, launch allow-list,   |
 |                 audit log                                      |
 |  Debug Journal  webview: narration timeline, ask box at a      |
 |                 breakpoint, mode switch, take-over             |
 |  Decorations    inline agent notes on code lines               |
 +---------------------------|------------------------------------+
                             | vscode.debug API + DAP tracker
                             v
              Real debug adapter (coreclr first)
                             |
                        Local process
```

- **Agent runtime.** Claude Code, connected over MCP. The extension has no chat model and holds no model API key.
- **Control.** The extension drives the session through `vscode.debug` and `DebugSession.customRequest`. It observes every Debug Adapter Protocol (DAP) message through a `DebugAdapterTracker`.
- **Control modes.** Watch (agent drives), Pair (agent proposes, person approves each step), Observe (person drives, agent comments). Pair is the default. A control lock means only one side steps at a time.
- **Companion skill.** A Claude Code skill (`debug-pair`) encodes the investigation loop: hypothesis, breakpoints, evidence, confirm or reject, report.

## Decisions already made by the owner

1. **Agent runtime is Claude Code over MCP.** No built-in chat panel, no Copilot tools in the first cut.
2. **.NET first.** The first debug adapter is coreclr, through the C# extension inside VS Code. Node follows later.
3. **Personal tooling, open source.** It lives in a public repository under the MIT licence.
4. **Test data only.** The debugger only ever runs against local processes and test data. It never runs against real customer data. It never attaches to a remote, shared or production process.
5. **Secrets live in the OS credential store.** That is Keychain on macOS and Credential Manager on Windows. The extension writes the MCP token to the store directly, because another process (Claude Code) must read it and `SecretStorage` does not allow that.
6. **Cross-platform.** The repository must clone and work on Windows as well as macOS. No bash-only scripts, no Unix sockets, no hard-coded path separators.

## Constraints

- **Loopback only.** The MCP endpoint binds to `127.0.0.1` and needs a per-session token.
- **Side-effect-free by default.** Agent `evaluate` accepts only a small expression grammar, with no method calls or assignments. The person can approve a single unsafe expression. The first cut has no tool for setting variables, hot reload or code edits.
- **Human in the loop.** The agent proposes fixes. It never applies one on its own.
- **Defence in depth on data.** The data rule is test data only. Redaction of secrets and PII-shaped values still runs before anything reaches the agent, in case a test fixture carries a real value by mistake.
- **Audit.** Every payload sent to the agent is logged locally, so the person can see what left the process.
- **Debugger licence.** Microsoft's `vsdbg` is licensed for use inside Microsoft VS Code only. The extension works through VS Code's own debug session, which is within that licence. It must never drive `vsdbg` headless. If headless mode is ever needed, `netcoredbg` (MIT) is the alternative.

## Non-goals

- Not a chat client. Claude Code is the chat.
- Not a remote or production debugger.
- Not an automatic fixer. It finds and explains. The person decides.
- Not a replacement for tests. Findings should lead to a failing test, through the existing bugfix flow.
- No Marketplace publishing in the first cut. It installs locally from a `.vsix`.

## Stack

- TypeScript, VS Code extension host, `@vscode/test-electron` for integration tests.
- A small .NET sample app with planted bugs is the end-to-end fixture. It is a test fixture, with synthetic data only.
