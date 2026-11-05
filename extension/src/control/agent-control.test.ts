import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkLine, resolveWorkspaceFile, workspaceRelative } from "./agent-control";

const ROOT = path.resolve("/work/repo");

describe("resolveWorkspaceFile", () => {
  it("resolves a path inside the workspace", () => {
    expect(resolveWorkspaceFile(ROOT, "fixtures/SampleApp/Domain/Basket.cs")).toBe(
      path.join(ROOT, "fixtures", "SampleApp", "Domain", "Basket.cs"),
    );
    expect(resolveWorkspaceFile(ROOT, "a/../b.cs")).toBe(path.join(ROOT, "b.cs"));
  });

  it.each(["../other/secret.cs", "a/../../b.cs", "/etc/passwd", "C:\\Windows\\win.ini", "", "."])(
    "refuses %j",
    (input) => {
      expect(() => resolveWorkspaceFile(ROOT, input)).toThrow();
    },
  );
});

describe("workspaceRelative", () => {
  it("uses forward slashes", () => {
    expect(workspaceRelative(ROOT, path.join(ROOT, "a", "b.cs"))).toBe("a/b.cs");
  });
});

describe("checkLine", () => {
  it.each([0, -1, 1.5, Number.NaN])("refuses %d", (line) => {
    expect(() => checkLine(line)).toThrow();
  });

  it("accepts line 1", () => {
    expect(() => checkLine(1)).not.toThrow();
  });
});
