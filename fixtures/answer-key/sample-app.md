# Answer key: SampleApp

This is the answer key for `fixtures/SampleApp`. It lists the planted bugs and the finding an investigation should reach.

**Keep it away from the agent during an evaluation.** The debug-pair skill evaluation (`extension/src/test/integration/debug-pair-skill.itest.ts`) tests whether the agent finds these bugs by debugging. If the agent reads this file, the test proves nothing. The evaluation copies the workspace without `fixtures/answer-key/` and blocks reads of it.

All data is synthetic. Order SYN-0001 has 8 products and 5 order lines with a gross of GBP 1200.00. Product 4 (Null Island) is discontinued, and its cancelled line is refunded.

## Bug 1: wrong calculation (the basket discount is never applied)

| | |
|---|---|
| Scenario | `discount` |
| Location | `Domain/Basket.cs:24` |
| Code | `var net = Gross * (1 - DiscountPercent / 100);` |
| Observed | `Discounted amount for #3: GBP 200.00` |
| Expected | `Discounted amount for #3: GBP 164.00` |

**Finding.** `DiscountPercent` is an `int`, so `18 / 100` is integer division and gives `0`. `net` then equals `Gross` (1200.00), and no discount is deducted. The correct net is 984.00. Product 3 carries 200.00 of the 1200.00 gross, so its share is 984.00 / 1200.00 x 200.00 = 164.00.

**Evidence at a breakpoint on line 24:** `Gross` is 1200.00, and after the line `net` is 1200.00, not 984.00. Evaluating `DiscountPercent / 100` gives `0`.

`InstalmentPlan` computes the discount correctly (`* (100 - DiscountPercent) / 100m`). A good investigation notices that the two classes differ.

## Bug 2: null path (a discontinued product has no supplier)

| | |
|---|---|
| Scenario | `refund` |
| Location | `Domain/Refunds.cs:11`, with the cause at `Domain/Product.cs:9` and `Data/order.json:8` |
| Code | `var supplier = product.Supplier.ToUpperInvariant();` |
| Observed | `System.NullReferenceException` at `Refunds.cs:11` |
| Expected | A refund line for GBP 25.00 on Null Island |

**Finding.** Product 4 (Null Island) is discontinued, and its entry in the order has no `supplier` field. `Product.Supplier` is declared as a non-nullable `string` with `= default!`. System.Text.Json leaves it `null` when the field is missing, so the compiler cannot warn. The refund path dereferences it.

**Evidence at the exception stop:** `product.Number` is 4, `product.IsDiscontinued` is true, and `product.Supplier` is `null`.

## Bug 3: off-by-one (the last instalment is never scheduled)

| | |
|---|---|
| Scenario | `instalments` |
| Location | `Domain/InstalmentPlan.cs:17` |
| Code | `for (var number = 1; number < InstalmentCount; number++)` |
| Observed | Two lines only: instalments 1 and 2 of 3, at GBP 328.00 each |
| Expected | Three lines: instalments 1, 2 and 3 of 3, at GBP 328.00 each |

**Finding.** `InstalmentCount` is 3, and the loop starts at 1 and stops before 3, so it runs twice. It should be `number <= InstalmentCount`. The net total (984.00) is still divided by three (328.00 each), so one third of the net total is never scheduled.

**Evidence at a breakpoint on line 17:** the loop body is hit twice, and `schedule.Count` is 2 on exit.

## Side-effecting getter (a debugger test, not a bug to find)

| | |
|---|---|
| Location | `Domain/Basket.cs:13` to `:20` (`Summary`), counter at `:17` |
| Observed without a debugger | `Summary reads: 1` in the `discount` scenario |

Reading `Basket.Summary` increments `_summaryReads`. The DAP read spike (`spikes/dap-read`) uses it to check whether inspecting variables runs property getters. If a debugger evaluates `Summary` while inspecting `basket`, the final line shows more than 1.

With implicit function evaluation on, expanding `this` in the Variables pane at the line 24 breakpoint runs the getter, and the run ends with `Summary reads: 2`. Under `SampleApp: discount (no implicit func-eval)` the run ends with `Summary reads: 1`. This was first seen on macOS on 24 Sep 2026 (C# extension 2.160.4). That is why the extension sends every agent read through the no-side-effects specifier `nse`. See `spikes/dap-read/FINDINGS.md`.

## Synthetic credentials (a redaction test, not a bug to find)

| | |
|---|---|
| Scenario | `secrets` (not part of `all`) |
| Location | `Domain/TestCredentials.cs`, with the breakpoint target at `Program.cs:39` |

`TestCredentials.CreateSynthetic()` holds an `example.com` email, the Visa test card number `4111 1111 1111 1111`, a made-up JWT, a localhost connection string and an `ApiToken` property. None of them is real. The guardrails integration test (`extension/src/test/integration/guardrails.itest.ts`) uses them to prove that every one is redacted before it reaches the agent.

The `wait` scenario sleeps for up to 120 seconds, so a test can attach a debugger to a running process.
