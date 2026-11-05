import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";
import { CredentialStore } from "../../mcp/credential-store";
import { credentialName } from "../../mcp/mcp.constants";

const TEST_PORT = 18399;

// Starts an isolated VS Code with only the C# extension, opened on the repository, and runs the suite in it.
// Caches live outside the repository, so the working tree never fills with third-party files.
async function main(): Promise<void> {
  const extensionRoot = path.resolve(__dirname, "..", "..", "..");
  const repoRoot = path.resolve(extensionRoot, "..");
  const cacheRoot = process.env.AI_DEBUGGER_TEST_CACHE ?? path.join(os.homedir(), ".ai-dotnet-debugger-vscode-test");

  const build = cp.spawnSync(
    "dotnet",
    ["build", path.join(repoRoot, "fixtures", "SampleApp", "SampleApp.csproj"), "-nologo", "-v", "q"],
    { stdio: "inherit" },
  );
  if (build.status !== 0) throw new Error("dotnet build of the sample app failed");

  const vscodeExecutablePath = await downloadAndUnzipVSCode({ cachePath: cacheRoot, version: "stable" });
  const extensionsDir = path.join(cacheRoot, "extensions");
  const [cli, ...rawCliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  const cliArgs = rawCliArgs.filter((arg) => !arg.startsWith("--extensions-dir"));
  const install = cp.spawnSync(
    cli ?? "code",
    [...cliArgs, "--extensions-dir", extensionsDir, "--install-extension", "ms-dotnettools.csharp"],
    { shell: process.platform === "win32", stdio: "inherit" },
  );
  if (install.status !== 0) throw new Error("installing ms-dotnettools.csharp failed");

  // A port of its own, so the test instance never touches the person's real server or token.
  const userData = path.join(cacheRoot, "user-data");
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({ "aiDebugger.port": TEST_PORT }, undefined, 2));

  // The extension must delete its token when VS Code closes. Check the credential store after the test VS Code exits.
  const store = new CredentialStore(process.platform, path.join(extensionRoot, "resources", "credentials"));
  const testCredential = credentialName(TEST_PORT);
  if (await store.exists(testCredential)) {
    await store.delete(testCredential);
    console.log(`Removed ${testCredential}, left by an earlier run, before the tests start.`);
  }

  await runTests({
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(__dirname, "suite.js"),
    launchArgs: [
      repoRoot,
      "--extensions-dir",
      extensionsDir,
      "--user-data-dir",
      userData,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
    ],
    vscodeExecutablePath,
  });

  if (await store.exists(testCredential)) {
    await store.delete(testCredential);
    throw new Error(`The test VS Code exited and left ${testCredential} in the credential store. The runner removed it.`);
  }
  console.log(`Credential check: no ${testCredential} left in the credential store.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
