import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  body: string;
  path: string;
}

const SKILLS_DIR = ".fable";
const MAX_SKILLS = 40;
const MAX_BODY_CHARS = 20000;

function frontmatter(raw: string): { meta: string; body: string } {
  if (!raw.startsWith("---")) return { meta: "", body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta: "", body: raw };
  return { meta: raw.slice(3, end), body: raw.slice(end + 4).replace(/^\r?\n/, "") };
}

function field(meta: string, key: string): string | undefined {
  const m = meta.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m?.[1]?.trim().replace(/^["']|["']$/g, "");
}

export async function loadSkills(cwd: string): Promise<Skill[]> {
  const dir = join(cwd, SKILLS_DIR, "skills");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (skills.length >= MAX_SKILLS) break;
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      if (!(await stat(path)).isFile()) continue;
    } catch {
      continue;
    }
    const raw = await readFile(path, "utf8");
    const { meta, body } = frontmatter(raw);
    const name = field(meta, "name") ?? entry.replace(/\.md$/, "");
    const description = field(meta, "description") ?? "";
    skills.push({ name, description, body: body.slice(0, MAX_BODY_CHARS), path });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function formatSkills(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}${s.description === "" ? "" : `: ${s.description}`}`);
  return `\n\nAVAILABLE SKILLS — read the skill file before doing the task:\n${lines.join("\n")}`;
}

export async function getSkill(cwd: string, name: string): Promise<Skill | null> {
  const skills = await loadSkills(cwd);
  return skills.find((s) => s.name === name) ?? null;
}