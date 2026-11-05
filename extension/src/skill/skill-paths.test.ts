import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { userSkillFolder } from "./skill-paths";

describe("userSkillFolder", () => {
  it("uses the skills folder in the person's Claude Code config", () => {
    expect(userSkillFolder({}, path.join("home", "a"))).toBe(path.join("home", "a", ".claude", "skills", "debug-pair"));
  });

  it("follows CLAUDE_CONFIG_DIR when it is set", () => {
    expect(userSkillFolder({ CLAUDE_CONFIG_DIR: path.join("cfg", "claude") }, path.join("home", "a"))).toBe(
      path.join("cfg", "claude", "skills", "debug-pair"),
    );
  });
});
