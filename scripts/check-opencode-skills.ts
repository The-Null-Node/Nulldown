import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const skillsRoot = join(process.cwd(), ".opencode", "skills");
const entries = await readdir(skillsRoot, { withFileTypes: true });
const failures: string[] = [];

for (const entry of entries) {
  if (!entry.isDirectory()) continue;

  const path = join(skillsRoot, entry.name, "SKILL.md");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    failures.push(`${entry.name}: missing SKILL.md`);
    continue;
  }

  const frontmatter = content.match(
    /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/,
  );
  if (!frontmatter) {
    failures.push(`${entry.name}: invalid name/description frontmatter`);
  } else if (frontmatter[1] !== entry.name) {
    failures.push(`${entry.name}: frontmatter name does not match directory`);
  }

  if (!content.includes("## Hosted Strategy")) {
    failures.push(`${entry.name}: missing Hosted Strategy section`);
  }
  if (!/https:\/\/nulldown\.app\/d\/[A-Za-z0-9]+/.test(content)) {
    failures.push(`${entry.name}: missing stable Nulldown strategy URL`);
  }

  if (
    entry.name === "nulldown-mcp-skill" &&
    (/```(?:bash|sh)[\s\S]*?\bnd\b/.test(content) ||
      /`bun run nd\b/.test(content))
  ) {
    failures.push(`${entry.name}: contains executable CLI guidance`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Verified ${entries.length} OpenCode skill routes.`);
}
