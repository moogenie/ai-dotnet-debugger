#!/bin/sh
# Claude Code headersHelper for the AI Debugger MCP server on macOS.
# It holds no secret. It reads the current token from the login keychain and prints the auth header.
# Usage: headers-helper.sh <credential-name>
set -eu
case "${1:-}" in
  ai-dotnet-debugger-mcp-[0-9]*) ;;
  *) echo "usage: headers-helper.sh ai-dotnet-debugger-mcp-<port>" >&2; exit 2 ;;
esac
token=$(/usr/bin/security find-generic-password -a ai-dotnet-debugger -s "$1" -w)
case "$token" in
  "" | *[!0-9a-f]*) echo "the keychain item does not hold an AI Debugger token" >&2; exit 1 ;;
esac
printf '{"Authorization":"Bearer %s"}\n' "$token"
