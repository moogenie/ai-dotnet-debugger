import * as fs from "node:fs";
import * as path from "node:path";
import Mocha from "mocha";

const SUITE_TIMEOUT_MS = 180_000;

export function run(): Promise<void> {
  const mocha = new Mocha({ color: true, timeout: SUITE_TIMEOUT_MS, ui: "bdd" });
  // AI_DEBUGGER_ITEST narrows the run to the test files whose names contain it.
  const only = process.env.AI_DEBUGGER_ITEST ?? "";
  for (const file of fs.readdirSync(__dirname).filter((name) => name.endsWith(".itest.js") && name.includes(only))) {
    mocha.addFile(path.join(__dirname, file));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
  });
}
