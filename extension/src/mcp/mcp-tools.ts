import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AgentGateway } from "../guardrails/agent-gateway";
import { MAX_ANNOTATION_CHARS } from "../annotations/annotation-store";
import { MAX_NARRATION_CHARS } from "../journal/journal-model";
import { MAX_DEPTH } from "../session/session.constants";
import { MAX_WAIT_SECONDS } from "./mcp.constants";

const READ_ONLY = { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true };
// A real-run evaluate can change program state, so evaluate does not claim to be read-only.
const MAY_CHANGE_STATE = { ...READ_ONLY, idempotentHint: false, readOnlyHint: false };
// Every tool marked DRIVES passes the control lock: in Pair mode it waits for the person's approval, for up to
// 100 seconds, then reports the proposal as pending.
// narrate, annotate and clear_annotations change only what the person sees, never the debugged process.
const SHOWS = { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: false };
const DRIVES = { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: false };

async function respond(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ text: JSON.stringify(await action(), undefined, 1), type: "text" }] };
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { content: [{ text, type: "text" }], isError: true };
  }
}

// The MCP tools. Each one calls the AgentGateway and nothing else.
export function registerTools(server: McpServer, gateway: AgentGateway): void {
  server.registerTool(
    "list_launch_configs",
    {
      annotations: READ_ONLY,
      description:
        "List the workspace launch configurations. The agent can start only those with isAgentVisible true: local coreclr launches that are not set to Production.",
    },
    () => respond(() => gateway.listLaunchConfigs()),
  );

  server.registerTool(
    "start_session",
    {
      annotations: DRIVES,
      description:
        "Start a debug session from a named launch configuration. It runs the configuration's preLaunchTask first, so it can take a while. Set breakpoints first, then call wait_for_event.",
      inputSchema: { name: z.string().min(1).describe("The launch configuration name, as list_launch_configs shows it.") },
    },
    ({ name }) => respond(() => gateway.startSession(name)),
  );

  server.registerTool(
    "stop_session",
    { annotations: DRIVES, description: "Stop the debug session the agent can see." },
    () => respond(() => gateway.stopSession()),
  );

  server.registerTool(
    "get_status",
    {
      annotations: READ_ONLY,
      description:
        "Show the session state (running or stopped, with the stopId), the agent's breakpoints, the person's breakpoints and why a session is hidden from the agent, if it is.",
    },
    () => respond(() => gateway.status()),
  );

  server.registerTool(
    "wait_for_event",
    {
      annotations: READ_ONLY,
      description:
        `Wait for the next event: stopped, continued, exited, a question the person asked, took_control, handed_back or proposal_decided. ` +
        `Returns at once if one is queued. ` +
        `Returns kind 'timeout' after at most ${MAX_WAIT_SECONDS} seconds; call it again to keep listening.`,
      inputSchema: {
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe(`How long to wait, from 1 to ${MAX_WAIT_SECONDS} seconds. The default is ${MAX_WAIT_SECONDS}.`),
      },
    },
    ({ timeoutSeconds }, extra) =>
      respond(() => {
        const progressToken = extra._meta?.progressToken;
        const total = timeoutSeconds ?? MAX_WAIT_SECONDS;
        return gateway.waitForEvent({
          onProgress: (elapsed) => {
            if (progressToken === undefined) return;
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: { message: `waited ${elapsed} s`, progress: elapsed, progressToken, total },
              })
              .catch(() => undefined);
          },
          signal: extra.signal,
          timeoutSeconds,
        });
      }),
  );

  server.registerTool(
    "set_breakpoint",
    {
      annotations: DRIVES,
      description: "Set a breakpoint. The agent's breakpoints are removed when the session ends.",
      inputSchema: {
        line: z.number().int().min(1).describe("The 1-based line number."),
        path: z.string().min(1).describe("The file path relative to the workspace root, with forward slashes."),
      },
    },
    ({ line, path }) => respond(() => gateway.setBreakpoint({ line, path })),
  );

  server.registerTool(
    "remove_breakpoint",
    {
      annotations: DRIVES,
      description: "Remove a breakpoint the agent set. The person's breakpoints cannot be removed.",
      inputSchema: { id: z.string().min(1).describe("The id set_breakpoint returned, for example bp1.") },
    },
    ({ id }) => respond(() => gateway.removeBreakpoint(id)),
  );

  server.registerTool(
    "continue",
    { annotations: DRIVES, description: "Resume the stopped process. Then call wait_for_event." },
    () => respond(() => gateway.resume()),
  );

  server.registerTool(
    "step",
    {
      annotations: DRIVES,
      description: "Step from the current stop: over the line, into the call, or out of the method. Then call wait_for_event.",
      inputSchema: { kind: z.enum(["over", "into", "out"]) },
    },
    ({ kind }) => respond(() => gateway.step(kind)),
  );

  server.registerTool(
    "pause",
    { annotations: DRIVES, description: "Pause the running process. Then call wait_for_event." },
    () => respond(() => gateway.pause()),
  );

  server.registerTool(
    "get_snapshot",
    {
      annotations: READ_ONLY,
      description:
        "Read the current stop: frames, locals to depth 1, the exception and the output since the last stop. " +
        "Each value has an accuracy label. 'exact' was read from memory. 'interpreted' came from the nse interpreter and can be wrong without an error. " +
        "Handles are valid only until the process resumes.",
    },
    () => respond(() => gateway.snapshot()),
  );

  server.registerTool(
    "get_variables",
    {
      annotations: READ_ONLY,
      description: `Expand a variable handle from get_snapshot or evaluate, to at most depth ${MAX_DEPTH}.`,
      inputSchema: {
        depth: z.number().int().min(1).max(MAX_DEPTH).optional(),
        handle: z.string().min(1),
      },
    },
    ({ depth, handle }) => respond(() => gateway.expand(handle, depth ?? 1)),
  );

  server.registerTool(
    "evaluate",
    {
      annotations: MAY_CHANGE_STATE,
      description:
        "Evaluate an expression in a frame of the current stop. A plain member path such as lines[0].Amount runs at once. " +
        "Anything else, such as a method call or arithmetic, needs the person's approval in VS Code. " +
        "They choose to run it under nse, which can be wrong without an error, or for real, which can change program state.",
      inputSchema: {
        expression: z.string().min(1),
        frameIndex: z.number().int().min(0).optional().describe("0 is the top frame."),
      },
    },
    ({ expression, frameIndex }) => respond(() => gateway.evaluate(expression, frameIndex ?? 0)),
  );

  server.registerTool(
    "narrate",
    {
      annotations: SHOWS,
      description:
        "Tell the person, in their Debug Journal in VS Code, what you see and what you will do next. Narrate each stop before you step or continue. " +
        "Pass the stopId of the stop you are describing. The call fails if that stop is no longer current, so a note never lands on the wrong stop. " +
        "Leave stopId out for a note that is not about a stop, such as your plan before start_session. " +
        "To answer a question from a 'question' event, pass its questionId as answers: the answer then shows under the question. " +
        "The text is redacted like every other payload.",
      inputSchema: {
        answers: z.number().int().min(1).optional().describe("The questionId of the question this narration answers."),
        stopId: z.number().int().min(1).optional().describe("The stopId from wait_for_event or get_snapshot."),
        text: z.string().min(1).max(MAX_NARRATION_CHARS).describe("Plain text. A few short sentences."),
      },
    },
    ({ answers, stopId, text }) => respond(() => gateway.narrate(text, stopId, answers)),
  );

  server.registerTool(
    "annotate",
    {
      annotations: SHOWS,
      description:
        "Pin a short note to a line in the person's editor, where they are looking. For example: 'productAmount is 0 here; expected 200'. " +
        "It shows at the end of the line until the session ends, the person dismisses it, or the file is edited. Use narrate for longer reasoning.",
      inputSchema: {
        line: z.number().int().min(1).describe("The 1-based line number."),
        path: z.string().min(1).describe("The file path relative to the workspace root, with forward slashes."),
        stopId: z.number().int().min(1).optional().describe("The stop the note is about, if any."),
        text: z.string().min(1).max(MAX_ANNOTATION_CHARS).describe("One short sentence of plain text."),
      },
    },
    ({ line, path, stopId, text }) => respond(() => gateway.annotate({ line, path, stopId, text })),
  );

  server.registerTool(
    "clear_annotations",
    {
      annotations: SHOWS,
      description: "Remove one of your annotations by id, or all of them when id is left out.",
      inputSchema: { id: z.string().min(1).optional().describe("The id annotate returned, for example a1.") },
    },
    ({ id }) => respond(() => gateway.clearAnnotations(id)),
  );

  server.registerTool(
    "get_output",
    {
      annotations: READ_ONLY,
      description: "Read the program output since the last stop, up to the last 50 lines.",
    },
    () => respond(() => gateway.output()),
  );
}
