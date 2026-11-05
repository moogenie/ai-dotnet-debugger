import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialStore, parseHelperOutput, type IProcessResult, type ProcessRunner } from "./credential-store";

const TOKEN = "0123456789abcdef".repeat(4);
const NAME = "ai-dotnet-debugger-mcp-18300";
const FOLDER = path.join("storage folder", "credentials");

interface ICall {
  args: readonly string[];
  command: string;
  stdin?: string;
}

function fakeRunner(token = TOKEN, writeCode = 0): { calls: ICall[]; run: ProcessRunner } {
  const calls: ICall[] = [];
  const run: ProcessRunner = (command, args, stdin) => {
    calls.push({ args, command, stdin });
    const isHelper = args.some((arg) => arg.includes("headers-helper"));
    const result: IProcessResult = isHelper
      ? { code: 0, stderr: "", stdout: `{"Authorization":"Bearer ${token}"}\n` }
      : { code: writeCode, stderr: writeCode ? "denied" : "", stdout: "" };
    return Promise.resolve(result);
  };
  return { calls, run };
}

describe("CredentialStore", () => {
  it("writes to the macOS keychain through stdin and proves it through the helper", async () => {
    const { calls, run } = fakeRunner();
    await new CredentialStore("darwin", FOLDER, run).write(NAME, TOKEN);
    expect(calls[0]).toEqual({
      args: ["-i"],
      command: "/usr/bin/security",
      stdin: `add-generic-password -U -a ai-dotnet-debugger -s ${NAME} -w ${TOKEN}\n`,
    });
    expect(calls[1]).toMatchObject({ args: [path.posix.join(FOLDER, "headers-helper.sh"), NAME], command: "/bin/sh" });
  });

  it("writes to Windows Credential Manager through stdin", async () => {
    const { calls, run } = fakeRunner();
    await new CredentialStore("win32", FOLDER, run).write(NAME, TOKEN);
    expect(calls[0]?.command).toBe("powershell.exe");
    expect(calls[0]?.args).toContain(path.win32.join(FOLDER, "credential-store.ps1"));
    expect(calls[0]?.stdin).toBe(`${TOKEN}\n`);
  });

  it("never puts the token on a command line", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      const { calls, run } = fakeRunner();
      const store = new CredentialStore(platform, FOLDER, run);
      await store.write(NAME, TOKEN);
      await store.delete(NAME);
      expect(calls.flatMap((call) => [call.command, ...call.args]).join(" ")).not.toContain(TOKEN);
    }
  });

  it("fails when the helper reads back a different token", async () => {
    const { run } = fakeRunner(randomBytes(32).toString("hex"));
    await expect(new CredentialStore("darwin", FOLDER, run).write(NAME, TOKEN)).rejects.toThrow(/does not match/);
  });

  it("fails when the store refuses the write", async () => {
    const { run } = fakeRunner(TOKEN, 1);
    await expect(new CredentialStore("win32", FOLDER, run).write(NAME, TOKEN)).rejects.toThrow(/denied/);
  });

  it("checks for the credential without asking for its secret", async () => {
    const mac = fakeRunner();
    await expect(new CredentialStore("darwin", FOLDER, mac.run).exists(NAME)).resolves.toBe(true);
    expect(mac.calls[0]).toMatchObject({ args: ["find-generic-password", "-a", "ai-dotnet-debugger", "-s", NAME], command: "/usr/bin/security" });
    expect(mac.calls[0]?.args).not.toContain("-w");
    expect(mac.calls[0]?.args).not.toContain("-g");

    const windows = fakeRunner();
    await expect(new CredentialStore("win32", FOLDER, windows.run).exists(NAME)).resolves.toBe(true);
    expect(windows.calls[0]?.args).toEqual(expect.arrayContaining([path.win32.join(FOLDER, "credential-store.ps1"), "-Action", "Exists", "-Target", NAME]));
  });

  it.each(["darwin", "win32"] as const)("reports a missing credential on %s and fails on any other error", async (platform) => {
    await expect(new CredentialStore(platform, FOLDER, fakeRunner(TOKEN, 44).run).exists(NAME)).resolves.toBe(false);
    await expect(new CredentialStore(platform, FOLDER, fakeRunner(TOKEN, 1).run).exists(NAME)).rejects.toThrow(/denied/);
  });

  it("refuses a malformed token or name before running anything", async () => {
    const { calls, run } = fakeRunner();
    const store = new CredentialStore("darwin", FOLDER, run);
    await expect(store.write(NAME, "not-hex")).rejects.toThrow(/64 lowercase hex/);
    await expect(store.write("login; rm -rf", TOKEN)).rejects.toThrow(/not an AI Debugger credential name/);
    expect(calls).toHaveLength(0);
  });

  it("refuses platforms without a supported credential store", () => {
    expect(() => new CredentialStore("linux", FOLDER)).toThrow(/macOS and Windows only/);
  });

  it("quotes helper paths that hold spaces", () => {
    expect(new CredentialStore("darwin", "/Users/a/Library/Application Support/x", fakeRunner().run).helperCommand(NAME)).toBe(
      `/bin/sh "/Users/a/Library/Application Support/x/headers-helper.sh" ${NAME}`,
    );
    expect(new CredentialStore("win32", "C:\\Users\\a\\AppData\\x", fakeRunner().run).helperCommand(NAME)).toBe(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\Users\\a\\AppData\\x\\headers-helper.ps1" -Target ${NAME}`,
    );
  });
});

describe("parseHelperOutput", () => {
  it("accepts the header object the helper prints", () => {
    expect(parseHelperOutput(`{"Authorization":"Bearer ${TOKEN}"}`)).toBe(`Bearer ${TOKEN}`);
  });

  it.each(["", "Bearer x", "{}", '{"Authorization":"Basic x"}', "null"])("rejects %j", (stdout) => {
    expect(() => parseHelperOutput(stdout)).toThrow();
  });
});
