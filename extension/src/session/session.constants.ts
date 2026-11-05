// Snapshot model limits.
export const MAX_FRAMES = 20;
export const DEFAULT_DEPTH = 1;
export const MAX_DEPTH = 3;
export const MAX_CHILDREN = 100;
export const MAX_VALUE_CHARS = 512;
export const MAX_PAYLOAD_BYTES = 65_536; // 64 KiB
export const OUTPUT_TAIL_LINES = 50;

// Every agent read goes through the no-side-effects specifier (see spikes/dap-read/FINDINGS.md).
export const NSE_SUFFIX = ", nse";

export const SUPPORTED_DEBUG_TYPE = "coreclr";
export const LOCALS_SCOPE_NAME = "Locals";

export const WATCHES_UNAVAILABLE_REASON =
  "VS Code has no extension API for reading the person's watch expressions.";
