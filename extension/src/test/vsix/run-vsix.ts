import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";
import { CredentialStore } from "../../mcp/credential-store";
import { credentialName } from "../../mcp/mcp.constants";

const TEST_PORT = 18399;

// Installs ai-dotnet-debugger.vsix into an isolated VS Code, as a person would install it, and runs vsix-suite.js there.
// The extension under test loads from the installed package, not from this folder. Run `npm run package` first.
async function main(): Promise<void> {
  const extensionRoot = path.resolve(__dirname, "..", "..", "..");
  const repoRoot = path.resolve(extensionRoot, "..");
  const vsix = path.join(extensionRoot, "ai-dotnet-debugger.vsix");
  if (!fs.existsSync(vsix)) throw new Error("ai-dotnet-debugger.vsix is missing. Run npm run package first.");
  const cacheRoot = process.env.AI_DEBUGGER_TEST_CACHE ?? path.join(os.homedir(), ".ai-dotnet-debugger-vscode-test");

  const dotnetBuild = cp.spawnSync("dotnet", ["build", path.join(repoRoot, "fixtures", "SampleApp", "SampleApp.csproj"), "-nologo", "-v", "q"], {
    stdio: "inherit",
  });
  if (dotnetBuild.status !== 0) throw new Error("dotnet build of the sample app failed");

  // Fresh folders each run, so an earlier install can never stand in for this one.
  const extensionsDir = path.join(cacheRoot, "extensions-vsix");
  const userData = path.join(cacheRoot, "user-data-vsix");
  fs.rmSync(userData, { force: true, recursive: true });

  const vscodeExecutablePath = await downloadAndUnzipVSCode({ cachePath: cacheRoot, version: "stable" });
  const [cli, ...rawCliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  const cliArgs = rawCliArgs.filter((arg) => !arg.startsWith("--extensions-dir"));
  // Uninstall any earlier copy through VS Code, so this run installs the package just built.
  cp.spawnSync(cli ?? "code", [...cliArgs, "--extensions-dir", extensionsDir, "--uninstall-extension", "moogenie.ai-dotnet-debugger"], {
    shell: process.platform === "win32",
    stdio: "ignore",
  });
  for (const extension of ["ms-dotnettools.csharp", vsix]) {
    const install = cp.spawnSync(cli ?? "code", [...cliArgs, "--extensions-dir", extensionsDir, "--install-extension", extension, "--force"], {
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    if (install.status !== 0) throw new Error(`installing ${path.basename(extension)} failed`);
  }

  // VS Code gives each extension its own vscode API object, chosen by the path of the file that loads it.
  // The test answers the extension's prompts by replacing showWarningMessage, so it must use the installed
  // extension's object. It is bundled into the installed folder of this throwaway install. The .vsix is not changed.
  const installed = fs.readdirSync(extensionsDir).find((name) => name.startsWith("moogenie.ai-dotnet-debugger-"));
  if (!installed) throw new Error("the installed extension folder is missing");
  const testFile = path.join(extensionsDir, installed, "vsix-test", "installed.vsixtest.js");
  await build({
    bundle: true,
    entryPoints: [path.join(extensionRoot, "src", "test", "vsix", "installed.vsixtest.ts")],
    external: ["vscode"],
    format: "cjs",
    outfile: testFile,
    platform: "node",
    target: "node22",
  });
  process.env.AI_DEBUGGER_VSIX_TEST_FILE = testFile;

  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({ "aiDebugger.port": TEST_PORT }, undefined, 2));

  // The extension writes its skill into CLAUDE_CONFIG_DIR, so the person's own ~/.claude is never touched.
  // The folder is made here, just before the try that removes it.
  const claudeConfig = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dotnet-debugger-vsix-claude-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  process.env.AI_DEBUGGER_VSIX_USER_DATA = userData;
  process.env.AI_DEBUGGER_VSIX_EXTENSIONS = extensionsDir;
  const store = new CredentialStore(process.platform, path.join(extensionRoot, "resources", "credentials"));
  const testCredential = credentialName(TEST_PORT);
  try {
    await runTests({
      extensionDevelopmentPath: path.join(extensionRoot, "test-host"),
      extensionTestsPath: path.join(__dirname, "vsix-suite.js"),
      launchArgs: [repoRoot, "--extensions-dir", extensionsDir, "--user-data-dir", userData, "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes"],
      vscodeExecutablePath,
    });
  } finally {
    fs.rmSync(claudeConfig, { force: true, recursive: true });
  }
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
