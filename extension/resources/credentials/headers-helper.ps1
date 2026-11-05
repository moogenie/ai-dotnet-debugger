# Claude Code headersHelper for the AI Debugger MCP server on Windows.
# It holds no secret. It reads the current token from Credential Manager and prints the auth header.
# Usage: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File headers-helper.ps1 -Target ai-dotnet-debugger-mcp-<port>
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^ai-dotnet-debugger-mcp-\d+$')][string]$Target
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AiDebuggerCredential
{
    private const int CredTypeGeneric = 1;
    private const int CredPersistSession = 1;
    private const int ErrorNotFound = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, int flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, int type, int flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    // Session persistence: the token disappears at logoff. The extension writes a new one on every activation.
    public static void Write(string target, string user, string secret)
    {
        byte[] blob = Encoding.Unicode.GetBytes(secret);
        IntPtr buffer = Marshal.AllocHGlobal(blob.Length);
        try
        {
            Marshal.Copy(blob, 0, buffer, blob.Length);
            Credential credential = new Credential();
            credential.Type = CredTypeGeneric;
            credential.TargetName = target;
            credential.UserName = user;
            credential.CredentialBlobSize = blob.Length;
            credential.CredentialBlob = buffer;
            credential.Persist = CredPersistSession;
            if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static string Read(string target)
    {
        IntPtr pointer;
        if (!CredRead(target, CredTypeGeneric, 0, out pointer)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            return Marshal.PtrToStringUni(credential.CredentialBlob, credential.CredentialBlobSize / 2);
        }
        finally
        {
            CredFree(pointer);
        }
    }

    public static void Delete(string target)
    {
        if (CredDelete(target, CredTypeGeneric, 0)) return;
        int error = Marshal.GetLastWin32Error();
        if (error != ErrorNotFound) throw new Win32Exception(error);
    }
}
'@
$token = [AiDebuggerCredential]::Read($Target)
if ($token -notmatch '^[0-9a-f]{64}$') {
    [Console]::Error.WriteLine('the credential does not hold an AI Debugger token')
    exit 1
}
[Console]::Out.WriteLine('{"Authorization":"Bearer ' + $token + '"}')
