// Redaction is defence in depth: the data rule is test data only, and this catches a real value
// that reaches a fixture by mistake. Built-in rules always run; settings can only add rules.

export interface IRedactionRule {
  name: string;
  pattern: RegExp;
}

export interface IAdditionalRuleSetting {
  name?: unknown;
  pattern?: unknown;
}

export interface IRedactionResult<T> {
  counts: Record<string, number>;
  value: T;
}

const SENSITIVE_WORDS =
  "password|passwd|pwd|secret|token|api[_-]?key|authorization|connection[_-]?string|credential|private[_-]?key|access[_-]?key|account[_-]?key";

export const SENSITIVE_NAME = new RegExp(`(${SENSITIVE_WORDS})`, "i");

const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;
const CARD_MIN_DIGITS = 13;
const CARD_MAX_DIGITS = 19;
const LUHN_DOUBLE_FACTOR = 2;
const LUHN_DOUBLE_THRESHOLD = 9;
const LUHN_MODULUS = 10;

export const BUILT_IN_RULES: readonly IRedactionRule[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: "connection-string",
    pattern: /\b(?:Password|Pwd|User ID|UID|AccountKey|SharedAccessKey)\s*=\s*[^;"'}\r\n]*/gi,
  },
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // Catches "ApiToken = value" inside a display string, where the member name is not a separate field.
  {
    name: "sensitive-assignment",
    pattern: new RegExp(`\\b\\w*(?:${SENSITIVE_WORDS})\\w*\\s*[=:]\\s*"?[^\\s,;}"]+"?`, "gi"),
  },
];

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= LUHN_DOUBLE_FACTOR;
      if (digit > LUHN_DOUBLE_THRESHOLD) digit -= LUHN_DOUBLE_THRESHOLD;
    }
    sum += digit;
    double = !double;
  }
  return sum % LUHN_MODULUS === 0;
}

export function parseAdditionalRules(settings: readonly IAdditionalRuleSetting[]): {
  invalid: string[];
  rules: IRedactionRule[];
} {
  const rules: IRedactionRule[] = [];
  const invalid: string[] = [];
  for (const setting of settings) {
    const name = typeof setting.name === "string" && setting.name ? setting.name : "custom";
    if (typeof setting.pattern !== "string" || !setting.pattern) {
      invalid.push(name);
      continue;
    }
    try {
      rules.push({ name: `custom:${name}`, pattern: new RegExp(setting.pattern, "g") });
    } catch {
      invalid.push(name);
    }
  }
  return { invalid, rules };
}

export class Redactor {
  private readonly rules: readonly IRedactionRule[];

  public constructor(additionalRules: readonly IRedactionRule[] = []) {
    this.rules = [...BUILT_IN_RULES, ...additionalRules];
  }

  public redactText(text: string, counts: Record<string, number> = {}): string {
    let result = text.replace(CARD_CANDIDATE, (match) => {
      const digits = match.replace(/[ -]/g, "");
      if (digits.length < CARD_MIN_DIGITS || digits.length > CARD_MAX_DIGITS || !luhnValid(digits)) return match;
      counts["card-number"] = (counts["card-number"] ?? 0) + 1;
      return "[redacted:card-number]";
    });
    for (const rule of this.rules) {
      result = result.replace(rule.pattern, () => {
        counts[rule.name] = (counts[rule.name] ?? 0) + 1;
        return `[redacted:${rule.name}]`;
      });
    }
    return result;
  }

  public redact<T>(payload: T): IRedactionResult<T> {
    const counts: Record<string, number> = {};
    return { counts, value: this.walk(payload, counts) as T };
  }

  private walk(node: unknown, counts: Record<string, number>): unknown {
    if (typeof node === "string") return this.redactText(node, counts);
    if (Array.isArray(node)) return node.map((item) => this.walk(item, counts));
    if (node === null || typeof node !== "object") return node;
    const source = node as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) copy[key] = this.walk(value, counts);
    if (typeof source.name === "string" && typeof source.value === "string" && SENSITIVE_NAME.test(source.name)) {
      counts.name = (counts.name ?? 0) + 1;
      copy.value = "[redacted:name]";
    }
    return copy;
  }
}
