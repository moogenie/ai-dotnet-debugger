# AI Debugger

Debug a local .NET program together with Claude Code. Claude drives the real VS Code debugger. You watch every move, ask questions at a stop, and take control at any time.

## Rules that never bend

- **Test data only.** Use this extension only on local processes that hold test data. Never use it on real customer data, and never on a remote, shared or production process. Values Claude reads are sent to an AI model.
- **The extension keeps the agent out of risky sessions.** It hides attach sessions, `pipeTransport` and `processId` sessions, and any session with `ASPNETCORE_ENVIRONMENT` or `DOTNET_ENVIRONMENT` set to `Production`. You can still debug those yourself.
- **Redaction and audit.** Everything sent to Claude is redacted first: emails, card numbers, JWTs, connection strings, bearer tokens, AWS keys and private keys. Members with names such as `password` or `token` are redacted too. Every call is written to an audit log, which holds redacted values only. Run 'AI Debugger: Open audit log' to see it.
- **Nothing runs without your opt-in.** The extension does nothing in a workspace until you run 'AI Debugger: Enable for this workspace', and only in a trusted workspace.

## How secrets are stored

The extension and Claude Code share one secret: a token for the local MCP server.

- A new random token is made each time the server starts. It is deleted when VS Code closes.
- It is stored in the operating system's credential store: Keychain on macOS, Credential Manager on Windows. It is never written to a file and never passed on a command line.
- Claude Code reads it through a small helper script, which the extension copies into its own storage folder.
- The server listens on `127.0.0.1` only. It refuses a request without the token, from a browser, or for another host name.

Any program running as you can read your own credential store. While the server runs, such a program could use the token to read the debugged process through the same redacted, audited path.

## Install

You need VS Code 1.100 or later, the C# extension (`ms-dotnettools.csharp`), a .NET SDK, and Claude Code.

1. Install the package: run `code --install-extension ai-dotnet-debugger.vsix`, or choose 'Install from VSIX...' in the Extensions view.
2. Open your project folder and trust it.
3. Run **AI Debugger: Enable for this workspace**. Read the statement and confirm.
4. Run **AI Debugger: Register with Claude Code**. It shows the exact entry it adds to your Claude Code user config, and asks first. To undo it, run `claude mcp remove ai-dotnet-debugger -s user`.
5. When asked, install the **debug-pair** skill too. It teaches Claude how to investigate. You can install it later with **AI Debugger: Install the debug-pair skill for Claude Code**.
6. Start a new Claude Code session in the project and describe the bug. For example: "Use the debug-pair skill. The discount scenario prints GBP 200.00; I expected GBP 164.00."

The server uses port 18300. Change it with the `aiDebugger.port` setting. If the port is taken, the server does not start. It never moves to another port.

## The Debug Journal

Open it with **AI Debugger: Open Debug Journal**. It sits in the Run and Debug view.

- It shows each stop with its location, Claude's notes, your questions and Claude's proposals.
- Type a question in the ask box. It reaches Claude with the current stop and line.
- It shows only what the debugger or Claude reported. When it does not know something, it says so.

Claude can also pin short notes to lines in the editor. They go when the session ends, when you dismiss them, or when you edit the file.

## Control modes

Choose a mode in the Journal, or with **AI Debugger: Set control mode**.

- **Pair** (the default every time VS Code starts): each change Claude wants shows in the Journal with Approve and Reject. That covers breakpoints, step, continue, pause and stopping the session. Starting a session needs no approval.
- **Watch**: Claude drives without asking.
- **Observe**: Claude can only read and narrate.

Press any debug control yourself, such as Step Over, and you take control at once, in any mode. Claude is refused until you click **Hand back**.

## Values and accuracy

Each value Claude reads carries a label:

- **exact**: read from memory.
- **interpreted**: computed by the debugger's no-side-effects mode. It can be wrong without an error, for example in some decimal arithmetic.
- **executed**: you approved running the expression for real.

Claude confirms money and arithmetic by stepping over the line and reading the result, not from an interpreted value.

## Licence of the debugger

The C# extension's debugger may only be used inside Microsoft VS Code. This extension always works through a VS Code debug session and never runs the debugger on its own.
