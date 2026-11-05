// Launches a separate VS Code instance with only the C# extension and runs the probe in it.
// Cross-platform: no shell, paths built with path.join.
const cp = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} = require("@vscode/test-electron");

async function main() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  // Caches live outside the repository, so the working tree never fills with third-party files.
  const testRoot = process.env.AI_DEBUGGER_TEST_CACHE || path.join(os.homedir(), ".ai-dotnet-debugger-vscode-test");
  const extensionsDir = path.join(testRoot, "extensions");
  const userDataDir = path.join(testRoot, "user-data");

  const build = cp.spawnSync(
    "dotnet",
    ["build", path.join(repoRoot, "fixtures", "SampleApp", "SampleApp.csproj"), "-nologo", "-v", "q"],
    { stdio: "inherit" }
  );
  if (build.status !== 0) throw new Error("dotnet build of the sample app failed");

  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: "stable", cachePath: testRoot });
  const [cli, ...rawCliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  // Drop the helper's own --extensions-dir so the isolated folder below is the only one.
  const cliArgs = rawCliArgs.filter((arg) => !arg.startsWith("--extensions-dir"));
  const install = cp.spawnSync(
    cli,
    [...cliArgs, "--extensions-dir", extensionsDir, "--install-extension", "ms-dotnettools.csharp"],
    { encoding: "utf8", stdio: "inherit", shell: process.platform === "win32" }
  );
  if (install.status !== 0) throw new Error("installing ms-dotnettools.csharp failed");

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: __dirname,
    extensionTestsPath: path.join(__dirname, "suite", "index.js"),
    launchArgs: [
      repoRoot,
      "--extensions-dir", extensionsDir,
      "--user-data-dir", userDataDir,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
    ],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
