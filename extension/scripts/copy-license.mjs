// Copies the repository LICENSE next to package.json so that vsce puts it into the .vsix.
// The root LICENSE stays the only source. The copy is ignored by git.
// Cross-platform: run with `node scripts/copy-license.mjs` (npm run package runs it).
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
copyFileSync(join(root, "..", "LICENSE"), join(root, "LICENSE"));
