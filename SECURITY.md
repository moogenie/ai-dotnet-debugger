# Security policy

This extension reads the memory of a debugged process and sends it to an AI agent. We treat security reports as a priority.

## Report a vulnerability

Do not open a public issue for a security problem.

Report it privately through GitHub:

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem, the steps to reproduce it, and the version you used.

We reply within 7 days. We tell you when a fix is ready, and we credit you in the release notes unless you ask us not to.

## Supported versions

Only the latest version gets security fixes:

- the latest release on the Visual Studio Marketplace, when the extension is published there;
- the `.vsix` that you build from the latest commit on `main`.

Before you report a problem, check that it also occurs in one of these versions.

## In scope

- The MCP server: the loopback binding, the token check, and the host and origin checks.
- The token in the OS credential store and the helper scripts that read it.
- Redaction: a value that reaches the agent without redaction.
- The audit log: an agent call that is not logged, or a log entry that holds a value without redaction.
- The session guards: a way for the agent to reach an attach session, a production session, or a session that the person did not enable.
- The control modes: a way for the agent to act when the person did not give it control.
- Evaluation: a way for the agent to run code with side effects without the person's approval.

## Out of scope

- Problems in VS Code, the C# extension, `vsdbg` or Claude Code. Report them to their owners.
- A program that already runs as you and reads your own credential store. The README describes this limit.
- Use against real customer data or a remote, shared or production process. The extension does not support this use.
