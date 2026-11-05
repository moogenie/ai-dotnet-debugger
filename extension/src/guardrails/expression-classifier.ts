// Member reads run under nse without approval (see spikes/dap-read/FINDINGS.md).
// Anything else (calls, assignments, object creation, lambdas, operators) needs the person's one-off approval,
// because nse was proven on simple getters only.

export type ExpressionClass = { isSafe: true } | { isSafe: false; reason: string };

const IDENTIFIER = String.raw`(?:this|\$exception|@?[A-Za-z_][A-Za-z0-9_]*)`;
const MEMBER = String.raw`\s*\.\s*@?[A-Za-z_][A-Za-z0-9_]*`;
const INDEXER = String.raw`\s*\[\s*(?:\d+|"[^"\\]*")\s*\]`;
const ALLOWED_SPECIFIERS = new Set(["nse", "raw", "nq", "h", "d"]);
const SAFE_PATH = new RegExp(`^${IDENTIFIER}(?:${MEMBER}|${INDEXER})*$`);

const REASONS: readonly [RegExp, string][] = [
  [/=>/, "contains a lambda"],
  [/\+\+|--/, "increments or decrements a value"],
  [/(?<![=!<>])=(?!=)/, "assigns a value"],
  [/\bnew\b/, "creates an object"],
  [/\(/, "calls a method or uses a cast"],
  [/;/, "contains more than one statement"],
];

export function classifyExpression(expression: string): ExpressionClass {
  const [path, ...specifiers] = expression.split(",").map((part) => part.trim());
  if (!path) return { isSafe: false, reason: "is empty" };
  const unknownSpecifier = specifiers.find((specifier) => !ALLOWED_SPECIFIERS.has(specifier));
  if (unknownSpecifier !== undefined) {
    return { isSafe: false, reason: `uses the format specifier '${unknownSpecifier}'` };
  }
  if (SAFE_PATH.test(path)) return { isSafe: true };
  const match = REASONS.find(([pattern]) => pattern.test(path));
  return { isSafe: false, reason: match?.[1] ?? "is not a plain member path" };
}
