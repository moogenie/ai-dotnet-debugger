import { NSE_SUFFIX } from "./session.constants";

// vsdbg appends the declared type to some names, for example "lines [IReadOnlyList]" or "[0] [OrderLine]".
const TYPE_SUFFIX = /^(.+?) \[[^\]]*\]$/;
const NSE_SPECIFIER = /,\s*nse\b/;
const NSE_SPECIFIER_GLOBAL = /,\s*nse\b/g;
// A literal or a bare type display, such as {SampleApp.Domain.Basket}, is read without running code.
const LITERAL_VALUE = /^(?:-?\d[\d.,eE+-]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|true|false|null|\{[^\s{}]+\})$/;

export function stripTypeSuffix(name: string): string {
  return TYPE_SUFFIX.exec(name)?.[1] ?? name;
}

export function withNse(expression: string): string {
  const trimmed = expression.trim();
  return NSE_SPECIFIER.test(trimmed) ? trimmed : `${trimmed}${NSE_SUFFIX}`;
}

export function truncate(value: string, maxChars: number): { isTruncated: boolean; value: string } {
  return value.length > maxChars
    ? { isTruncated: true, value: value.slice(0, maxChars) }
    : { isTruncated: false, value };
}

export function toForwardSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

export function withoutNse(expression: string): string {
  return expression.replace(NSE_SPECIFIER_GLOBAL, "").trim();
}

export function isLiteralValue(value: string): boolean {
  return LITERAL_VALUE.test(value.trim());
}
