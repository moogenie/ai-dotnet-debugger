# Spike findings: DAP read

Throwaway spike code. The findings matter, not the code. Raw data is in `results/results-win32.json`. Each run also writes a full DAP message log, `results/messages-<platform>.json`, which is not tracked.

## Set-up

- First run: macOS (Darwin 27.0.0, arm64), 14 Oct 2026, VS Code 1.141.1, C# extension 2.160.4. That run used an earlier version of the sample app. Its raw data is not kept.
- Kept run: Windows 11 (10.0.26300, x64), 5 Nov 2026, VS Code 1.145.0, C# extension 2.160.4, on the current sample app. Every result below holds on both runs.
- `@vscode/test-electron` 3.1.0 downloads VS Code and installs the C# extension into an isolated extensions folder.
- Caches live in `~/.ai-dotnet-debugger-vscode-test` (or `AI_DEBUGGER_TEST_CACHE`), outside the repository.
- Run it with `npm install` then `npm run spike` in this folder. It builds the sample app, starts VS Code on the repository, and runs `suite/index.js` inside it. To record macOS data again, run it on a Mac. It writes `results/results-darwin.json`.
- The probe reads the Basket counter as `this._summaryReads`. That is a field read, so measuring the counter runs no code.

## Results

| Question | Result |
|---|---|
| Can an extension read a stopped coreclr frame? | **Yes.** `stackTrace`, `scopes`, `variables` and `evaluate` through `customRequest` returned the frame at `Basket.cs:24`, its locals and values. The exception stop returned `CLR/System.NullReferenceException` at `Refunds.cs:11`, with `product.Supplier` = null and `product.IsDiscontinued` = true. |
| Can the tracker tell UI control requests from extension requests? | **Yes.** A `next` sent through `customRequest` was tagged `extension`. A `next` caused by `workbench.action.debug.stepOver` was tagged `not-extension`. The tag comes from a list of commands the extension has just sent. |
| Does vsdbg honour `nse`? | **Yes.** With implicit evaluation on, `this.Summary, nse` returned the value and the counter did not change. A plain `this.Summary` then raised it by 1. |
| Does `nse` carry through to child members? | **Yes.** `this, nse` and `lines, nse`, expanded through their variable references, showed `Summary`, every `OrderLine` and its `ProductNumber` and `Amount`. The counter stayed at 5 throughout. |
| With `allowImplicitFuncEval` false, does inspection run getters? | **No, in any context.** `variables`, and `evaluate` in `watch`, `repl`, `hover`, `clipboard` and `variables` contexts, all returned "Implicit function evaluation is turned off by the user". So did `nse` and a method call. The counter stayed at 0, and the run ended with `Summary reads: 1`. |
| What does the agent lose with implicit evaluation off? | **Most of its view.** Every property is hidden, including record properties and `List.Count`. List items are reachable through `Raw View`, `Non-Public members` and `_items`, but each record item shows only hidden properties. Auto-property backing fields are not shown, and `showRawValues: true` does not change that. |
| How does the variables response mark a field apart from a property? | Locals and fields have `presentationHint.kind: "data"`. Properties have `kind: "property"`, or no kind and the `failedEvaluation` attribute when evaluation is off. |

With implicit evaluation on, every evaluate context ran the getter: the counter rose by 1 for each of `repl`, `hover`, `clipboard` and `variables`.

## Adapter quirks

- **Type suffix in names.** vsdbg adds the declared type to some variable names, for example `lines [IReadOnlyList]`, `productNumber [int]` and `[0] [OrderLine]`. `evaluateName` stays clean when it is present.
- **`evaluateName` drops `nse`.** Children of an `nse` root carry names such as `this.Summary`. Evaluating that name as given would run the getter for real.
- **Collection items have generated names.** Under `nse`, an item's `evaluateName` is `new System.Collections.Generic.ICollectionDebugView<...>(lines).Items[0]`.
- **First run downloads.** On a fresh profile, the C# extension downloads its components before it registers the `coreclr` adapter. Await the extension's `initializationFinished()` export before calling `startDebugging`.
- **`@vscode/test-electron` 2.5.x cannot launch VS Code 1.110 or later on macOS.** The binary moved from `Contents/MacOS/Electron` to `Contents/MacOS/Code`. Version 3.1.0 handles it.
- **Keep the caches outside the repository.** An in-repository `.vscode-test` folder fills the working tree with third-party JSON, which repository-wide tools then scan.

## Design consequence

The owner chose `nse` routing on 14 Oct 2026. Every agent read goes through `nse`, so inspection never runs a getter for real. Implicit evaluation stays on, so the agent keeps its view of properties. A method call, an assignment or any other expression that is not a plain member path needs the person's approval.

## Not covered

- `nse` on getters that do I/O, call native code or change static state.
- A real person clicking in the UI. The UI path was driven through the `workbench.action.debug.stepOver` command, which is what the toolbar button runs.
