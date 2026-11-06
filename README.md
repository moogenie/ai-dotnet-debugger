# ai-dotnet-debugger

A VS Code extension that lets an AI agent and a person debug a local .NET process together.

Claude Code drives the real VS Code debugger over MCP. It sets breakpoints, steps, and reads the stack, locals and watch results. You watch every move in the normal debug UI. You can ask a question at any breakpoint, and you can take control at any time.

**Status:** packaged as a local `.vsix`. To install and use it, read `extension/README.md`.

## Build and install

In `extension/`, with Node 22 or later and npm 11 or later:

```
npm ci
npm run package
code --install-extension ai-dotnet-debugger.vsix
```

`npm run verify` runs lint, the unit tests and the integration tests. `npm run test:vsix` installs the package into an isolated VS Code and runs a real Claude Code session against it.

## Get started with the sample app

`fixtures/SampleApp` has planted bugs. Use it for your first session.

### 1. Load the extension in VS Code

1. Open this repository folder in VS Code.
2. Trust the workspace if VS Code asks.
3. Run **Developer: Reload Window** from the Command Palette. This loads a newly installed package.

### 2. Turn it on for this workspace

1. Run **AI Debugger: Enable for this workspace**.
2. Read the statement and confirm. The MCP server starts on `127.0.0.1:18300`.
3. Run **AI Debugger: Register with Claude Code** if you have not done so before. It adds a user-level entry, once per machine.
4. You do not need to install the skill for this repository. It is already in `.claude/skills/debug-pair/`.

### 3. Open the Debug Journal

1. Run **AI Debugger: Open Debug Journal**. It opens in the Run and Debug view.
2. Check that the mode is **Pair**. In Pair mode, you approve each breakpoint and step.

### 4. Check that Claude Code can connect

Run this in a terminal:

```
claude mcp get ai-dotnet-debugger
```

It should show the server as connected. If it shows `ECONNREFUSED`, nothing is listening on the port. Go back to step 2.

### 5. Start a Claude Code session

1. Run `claude` in this repository folder. Start a new session after the server starts, because each start makes a new token.
2. Describe the bug and name the skill. For example:

   > Use the debug-pair skill. The discount scenario prints GBP 200.00; I expected GBP 164.00.

3. Claude chooses a launch configuration, such as **SampleApp: discount**, and starts it.

### 6. Work together in the Journal

- **Approve or reject** each proposal. Pair mode waits for you.
- **Ask a question** in the ask box at any stop. Claude's answer appears under your question.
- **Take control** by pressing any debug button, such as Step Over. Click **Hand back** to let Claude drive again.
- **Change the mode** in the Journal. Watch lets Claude drive without asking. Observe lets Claude only read.

### 7. Read the report

Claude ends with a report: the root cause, its location and the evidence from each stop. Claude does not change the code. To fix the bug, start with a failing test that reproduces the finding.

### Other scenarios

The launch configurations also cover `instalments`, `refund`, `all` and `secrets`. Use `secrets` to check that redaction works. Run **AI Debugger: Open audit log** to see every call Claude made.

## Use it in another .NET project

The Claude Code entry is user-level. A Claude session in any project tries to connect to it. These conditions apply.

1. **Open the project in VS Code.** Trust it, and run **AI Debugger: Enable for this workspace**. You enable each workspace once.
2. **Use one VS Code window at a time.** The server always uses port 18300. A second window cannot start it while the port is taken. Claude connects to the first window you enabled.
3. **Start Claude in the same folder as that window.** Otherwise Claude reads one codebase and debugs another.
4. **Add a launch configuration.** Claude can only start configurations in that project's `.vscode/launch.json`. Each one must be `coreclr` with `"request": "launch"`. The extension hides attach sessions and any session with `ASPNETCORE_ENVIRONMENT` or `DOTNET_ENVIRONMENT` set to `Production`.
5. **Install the skill at user level.** Run **AI Debugger: Install the debug-pair skill for Claude Code** once. Without it, Claude has the tools but not the method.
6. **Reconnect after a VS Code restart.** Each restart makes a new token. Run `/mcp` in Claude Code to reconnect, or start a new session.
7. **Use test data only.** Values Claude reads go to an AI model, even after redaction. Never use a configuration that loads real customer data, for example a connection string to a shared database.

## Read next

- `extension/README.md`: install, registration with Claude Code, the Journal, the control modes and the data rules
- `delivery-brief.md`: purpose, shape, decisions, constraints and non-goals
- `.claude/skills/debug-pair/SKILL.md`: the skill that teaches Claude how to investigate

## Rules that never bend

- Test data only. Never real customer data. Never a remote, shared or production process.
- Secrets live in the OS credential store (Keychain on macOS, Credential Manager on Windows).
- The agent proposes. The person decides.

## After you clone

Turn on the hook that refuses pushes to `main`. This works on macOS and Windows:

```
git config core.hooksPath .githooks
```

Changes reach `main` only through a reviewed pull request. See `branch-landing-strategy.json`.

## Security

Report a vulnerability privately. See `SECURITY.md`. Do not open a public issue.

## Licence

MIT. See `LICENSE`.
