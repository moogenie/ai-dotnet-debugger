import Mocha from "mocha";
import * as path from "node:path";

const SUITE_TIMEOUT_MS = 600_000;

export function run(): Promise<void> {
  const mocha = new Mocha({ color: true, timeout: SUITE_TIMEOUT_MS, ui: "bdd" });
  // run-vsix.ts bundles the test into the installed extension's folder. See the note there.
  mocha.addFile(process.env.AI_DEBUGGER_VSIX_TEST_FILE ?? path.join(__dirname, "installed.vsixtest.js"));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} .vsix test(s) failed`)) : resolve()));
  });
}
