---
name: debug-pair
description: Investigates a .NET bug with the ai-dotnet-debugger MCP tools, which drive the real VS Code debugger while the person watches. It loops through hypothesis, breakpoints, evidence, and confirm or reject. Then it reports the root cause and the evidence. It never changes code; a fix goes through the bugfix flow. Triggers on "debug this with me", "pair-debug", "find out why X prints Y" or "step through this". Also triggers on a bug report about a local process the tools can run. Not for writing a fix; hand the report to your bugfix flow. Not for code review. Never for a remote, shared or production process.
---

# Debug pair

Find out why a program misbehaves by watching it run in the debugger. The person is beside you in VS Code. The goal is a root cause backed by evidence you saw at a stop. It is not a fix.

The ai-dotnet-debugger tools work inside the person's VS Code. They see every stop, note and proposal in the Debug Journal, and they can take control at any time.

## When to use

- The person reports a wrong result, a crash or an odd value in a local .NET program.
- The person asks you to step through code with them, or to explain what happens at a line.
- A test fails and reading the code has not shown why.

## When not to use

- **Writing or applying a fix.** Report the finding, then hand off to the bugfix flow. See "Hand-off".
- **A remote, shared or production process.** The tools refuse attach sessions and Production environments on purpose. Do not try to get round that.
- **Real customer data.** Test data only. If a value looks like real personal or payment data, stop and tell the person.
- **A question you can answer by reading the code.** Read it first. Use the debugger when the code does not explain what happens.

## Before you start

1. Call `get_status`. Check the mode and who holds control:
   - **Pair** (the default): every change you make to the debugger waits for the person's approval. Starting a session does not.
   - **Watch**: your control calls run at once.
   - **Observe**: you can only read and narrate. Say so, and ask the person to start the program or change the mode.
2. Call `list_launch_configs`. Use only a configuration with `isAgentVisible` true.
3. Read the code around the symptom before you place a breakpoint. Use the file reading tools for that, not the debugger.

## The loop

Repeat until one hypothesis is confirmed by evidence.

1. **Hypothesis.** State one specific, testable claim. For example: "`net` already equals `Gross`, so no discount is deducted." Name the line and the value that would prove or disprove it.
2. **Breakpoints.** Place the fewest breakpoints that test it, with `set_breakpoint`. Tell the person why with `narrate` first, so they know what they are approving.
3. **Evidence.** Start the session or continue, then call `wait_for_event` until it returns `stopped`. Read with `get_snapshot`, `get_variables` and plain-path `evaluate`. Record each value with its stop, line and accuracy label.
4. **Confirm or reject.** Compare the evidence with the hypothesis. If it is rejected, say so in `narrate` and form the next one. Do not bend the evidence to fit.
5. **Report.** When a hypothesis is confirmed, pin the key value to its line with `annotate`. Stop the session with `stop_session`, then write the report.

Keep `wait_for_event` going between steps. Questions from the person arrive there.

## Reading values: the accuracy labels

Every value carries a label. Treat them differently.

- **exact**: read from memory. Trust it.
- **interpreted**: computed by the debugger's no-side-effects interpreter (`nse`). It can be wrong without any error. It is known to compute some decimal arithmetic as 0. Treat it as unconfirmed.
- **executed**: the person approved running the expression for real. Trust the value, but remember the run may have changed program state.

**The rule for money and arithmetic.** Never conclude a calculated value from an `interpreted` result or from evaluating an expression. Confirm it this way:

1. Stop on the line that computes it.
2. Call `step` with kind `over`, then `wait_for_event` for the next stop.
3. Read the local the line assigned, with `get_snapshot`. It should now be `exact`.

Use the stepped value as the evidence. An expression such as `DiscountPercent / 100` or a method call needs the person's approval. If they refuse, step instead.

## Working with the person

- **Narrate each stop** with `narrate` and its `stopId`: what you see, and what you will do next. Keep it to two or three short sentences.
- **Annotate findings** with `annotate` on the exact line, for example "net is 1000.00 here; expected 820.00". Use it for facts, not guesses.
- **Answer questions.** A `question` event is the person asking about a stop. Answer it with `narrate`, passing the event's `questionId` as `answers`, so the answer shows under the question. Answer in your reply too, and before you continue.
- **Proposals.** In Pair mode a control call can return "pending" after 100 seconds. Keep reading, and call `wait_for_event` for `proposal_decided`. If it is approved, repeat the same call at the same stop. If it is rejected, do not repeat it; narrate and choose another step.
- **The person takes control.** On `took_control`, stop driving. Keep reading and narrating. Wait for `handed_back` before any control call.
- **Stale handles.** A variable handle is valid only at its stop. After the process moves, read again.

## Never change code

This skill reads and reports. It never edits, writes or deletes a file. It never changes a variable in the running program. It never runs a command that changes the workspace. If the person asks for a fix during the investigation, finish the report first, then hand off.

## Report

End with this report, in plain text:

```
Symptom: <what the person saw, with the observed and expected output>
Root cause: <one or two sentences>
Location: <workspace-relative path>:<line>
Evidence:
- stop <n>, <path>:<line>: <name> = <value> (<accuracy label>)
- ...
Rejected hypotheses: <each one, and the evidence that rejected it>
Confidence: <high, medium or low, and why>
Sensitive area: <none, or which: money calculation, payments or refunds, personal data, security>
Next step: <a failing test that reproduces it; then the bugfix flow>
```

Every evidence line must come from a stop you saw in this session. Do not report a value you only inferred from the code.

**Sensitive area.** Always fill in this line. If the faulty code computes or moves money, touches personal data, or affects security, name the area. Then say the fix needs a careful review and a test before it ships. Write "none" only when the code clearly touches none of these.

## Hand-off

A fix goes through your bugfix flow, not this skill. Give it the report. The first step of that flow should be a failing test that reproduces the finding.

Suggest the failing test in "Next step". Do not write it here.
