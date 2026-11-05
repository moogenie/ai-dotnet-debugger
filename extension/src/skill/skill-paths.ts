import * as os from "node:os";
import * as path from "node:path";

export const SKILL_NAME = "debug-pair";
export const SKILL_FILE = "SKILL.md";

// Where Claude Code looks for the person's own skills. CLAUDE_CONFIG_DIR moves the whole config folder.
export function userSkillFolder(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "skills", SKILL_NAME);
}
