// Bundles the extension into dist/ for the .vsix: one file for the extension host, one for the Journal webview,
// and a copy of the debug-pair skill. Cross-platform: run with `node scripts/bundle.mjs` (npm run bundle).
import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { force: true, recursive: true });

await build({
  bundle: true,
  entryPoints: [join(root, "src", "extension.ts")],
  external: ["vscode"],
  format: "cjs",
  legalComments: "linked",
  outfile: join(dist, "extension.js"),
  platform: "node",
  // Line mapping only. The map keeps stack traces readable but carries no source text into the .vsix.
  sourcemap: true,
  sourcesContent: false,
  target: "node22",
});

await build({
  bundle: true,
  entryPoints: [join(root, "src", "journal", "webview", "journal-client.ts")],
  format: "esm",
  outfile: join(dist, "webview", "journal-client.js"),
  platform: "browser",
  target: "es2022",
});

// The skill's source of truth is the repository's .claude/skills folder.
cpSync(join(root, "..", ".claude", "skills", "debug-pair"), join(dist, "skills", "debug-pair"), { recursive: true });
console.log("Bundled into dist/.");
