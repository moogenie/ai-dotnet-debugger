# Changelog

## 0.0.1 (preview)

First preview release.

- Claude Code drives the real VS Code debugger over a local MCP server, alongside a person.
- The agent sets breakpoints, steps, and reads a stopped .NET frame through the C# extension.
- The Debug Journal shows every agent action. The person asks questions at a stop and takes control at any time.
- Control modes: Pair, Watch and Observe.
- Redaction and an audit log apply to every value sent to the agent.
- The MCP token lives in the OS credential store. The server listens on `127.0.0.1` only.
- The debug-pair skill for Claude Code ships with the extension.
