# Claude orientation: ai-dotnet-debugger

Repo-scoped orientation for Claude. `AGENTS.md` and `.github/copilot-instructions.md` carry the same orientation for other agents. Keep all three consistent.

## What this repository is

A VS Code extension that lets Claude Code drive the real VS Code debugger over MCP, alongside a person. The agent sets breakpoints, steps and reads a stopped frame. The person watches, asks questions at a breakpoint, and takes control at any time.

## Read first

1. `README.md`: what it is, how to build it and how to start
2. `delivery-brief.md`: why this exists, the shape, the decisions already made, the non-goals
3. `extension/README.md`: install, the Journal, the control modes and the data rules

## Delivery state

This repository started with a fresh history. Delivery state (objectives, work items, decisions and verification reports) is not tracked yet. Do not invent it. Ask the owner what to work on next.

## Branching and landing

`branch-landing-strategy.json` is the authority. In short:

- **One branch per change**, with a conventional-commit type prefix, for example `feat/<slug>` or `chore/<slug>`.
- **Never commit or push to `main`.**
- **Open a pull request, then stop.** State what changed, the verification evidence, and anything uncertain.
- **Merge only after the owner approves**, in chat or on the pull request. Squash merge with a conventional-commit title, then delete the branch.
- **Never bypass the hook.** Do not use `git push --no-verify`. Only the owner may bypass it.

A local `pre-push` hook in `.githooks/` refuses pushes to `main`. Each clone must turn it on once, on macOS or Windows:

```
git config core.hooksPath .githooks
```

## Scope and constraints

- **Test data only.** The debugger runs against local processes and test data. It never runs against real customer data. It never attaches to a remote, shared or production process.
- **Secrets live in the OS credential store.** Keychain on macOS, Credential Manager on Windows. The MCP token is written there directly, not through `SecretStorage`, so Claude Code can read it. Never write a secret to a file or pass one on a command line.
- **Cross-platform.** The repository must clone and work on Windows as well as macOS. No bash-only scripts, no Unix sockets, no hard-coded path separators. Use `path.join` and npm scripts.
- **Loopback only.** The MCP endpoint binds to `127.0.0.1` and needs a per-session token.
- **Human in the loop.** The agent proposes fixes. It never applies one on its own. Setting variables, hot reload and code edits need the person's approval.
- **Debugger licence.** Microsoft's `vsdbg` is licensed for use inside Microsoft VS Code only. Work through a VS Code debug session. Never drive `vsdbg` headless. `netcoredbg` (MIT) is the alternative if headless mode is ever needed.

**Data note.** This tool reads process memory and sends it to an AI agent. That is why the test-data-only rule, redaction and the audit log are not optional. Flag any change that weakens them.
