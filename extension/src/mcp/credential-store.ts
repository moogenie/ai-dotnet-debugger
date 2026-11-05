import { spawn } from "node:child_process";
import * as path from "node:path";
import { CREDENTIAL_ACCOUNT } from "./mcp.constants";

export interface IProcessResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

// Runs a program with an argument array and no shell. Secrets go through stdin only.
export type ProcessRunner = (command: string, args: readonly string[], stdin?: string) => Promise<IProcessResult>;

export const runProcess: ProcessRunner = (command, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
    child.stdin.end(stdin ?? "");
  });

export class CredentialStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const NAME_PATTERN = /^ai-dotnet-debugger-mcp-\d+$/;
const SECURITY = "/usr/bin/security";
const POWERSHELL = "powershell.exe";
const POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
const SHELL = "/bin/sh";
const ITEM_NOT_FOUND = 44;

// Keychain on macOS and Credential Manager on Windows. The helper scripts live in scriptsFolder, which is the
// extension's global storage.
export class CredentialStore {
  public constructor(
    private readonly platform: NodeJS.Platform,
    private readonly scriptsFolder: string,
    private readonly run: ProcessRunner = runProcess,
  ) {
    if (platform !== "darwin" && platform !== "win32") {
      throw new CredentialStoreError(`AI Debugger stores its token on macOS and Windows only, not on ${platform}.`);
    }
  }

  // The command Claude Code runs as the headersHelper. Paths are quoted because global storage can hold spaces.
  public helperCommand(name: string): string {
    const helper = this.helperArgs(name);
    return [helper.command, ...helper.args].map(quoteForShell).join(" ");
  }

  public async write(name: string, token: string): Promise<void> {
    checkName(name);
    if (!TOKEN_PATTERN.test(token)) throw new CredentialStoreError("The token must be 64 lowercase hex characters.");
    const result =
      this.platform === "darwin"
        ? await this.run(SECURITY, ["-i"], `add-generic-password -U -a ${CREDENTIAL_ACCOUNT} -s ${name} -w ${token}\n`)
        : await this.run(POWERSHELL, [...POWERSHELL_FLAGS, this.script("credential-store.ps1"), "-Action", "Write", "-Target", name], `${token}\n`);
    if (result.code !== 0) throw new CredentialStoreError(`Writing the token failed: ${result.stderr.trim()}`);
    // security -i can exit 0 after a failed command, so the write is proven by reading it back through the helper.
    if ((await this.readThroughHelper(name)) !== token) {
      throw new CredentialStoreError("The token read back through the headers helper does not match the one written.");
    }
  }

  public async delete(name: string): Promise<void> {
    checkName(name);
    const result =
      this.platform === "darwin"
        ? await this.run(SECURITY, ["delete-generic-password", "-a", CREDENTIAL_ACCOUNT, "-s", name])
        : await this.run(POWERSHELL, [...POWERSHELL_FLAGS, this.script("credential-store.ps1"), "-Action", "Delete", "-Target", name]);
    if (result.code !== 0 && result.code !== ITEM_NOT_FOUND) {
      throw new CredentialStoreError(`Deleting the token failed: ${result.stderr.trim()}`);
    }
  }

  // Checks for the credential without reading its secret: find-generic-password prints the secret only with -w or -g.
  public async exists(name: string): Promise<boolean> {
    checkName(name);
    const result =
      this.platform === "darwin"
        ? await this.run(SECURITY, ["find-generic-password", "-a", CREDENTIAL_ACCOUNT, "-s", name])
        : await this.run(POWERSHELL, [...POWERSHELL_FLAGS, this.script("credential-store.ps1"), "-Action", "Exists", "-Target", name]);
    if (result.code === 0) return true;
    if (result.code === ITEM_NOT_FOUND) return false;
    throw new CredentialStoreError(`Checking for the token failed: ${result.stderr.trim()}`);
  }

  // Runs the same helper Claude Code runs and returns the token it prints.
  public async readThroughHelper(name: string): Promise<string> {
    checkName(name);
    const helper = this.helperArgs(name);
    const result = await this.run(helper.command, helper.args);
    if (result.code !== 0) throw new CredentialStoreError(`The headers helper failed: ${result.stderr.trim()}`);
    const header = parseHelperOutput(result.stdout);
    return header.slice("Bearer ".length);
  }

  private helperArgs(name: string): { args: string[]; command: string } {
    checkName(name);
    return this.platform === "darwin"
      ? { args: [this.script("headers-helper.sh"), name], command: SHELL }
      : { args: [...POWERSHELL_FLAGS, this.script("headers-helper.ps1"), "-Target", name], command: POWERSHELL };
  }

  // Joins with the store's platform, not the host's, so a store built for one platform gives the same path on any host.
  private script(fileName: string): string {
    return (this.platform === "darwin" ? path.posix : path.win32).join(this.scriptsFolder, fileName);
  }
}

export function parseHelperOutput(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CredentialStoreError("The headers helper did not print JSON.");
  }
  const authorization = (parsed as { Authorization?: unknown } | null)?.Authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new CredentialStoreError("The headers helper did not print an Authorization header.");
  }
  return authorization;
}

function checkName(name: string): void {
  if (!NAME_PATTERN.test(name)) throw new CredentialStoreError(`'${name}' is not an AI Debugger credential name.`);
}

function quoteForShell(part: string): string {
  return /^[\w./:-]+$/.test(part) ? part : `"${part}"`;
}
