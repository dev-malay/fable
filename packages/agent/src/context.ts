import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface LoadedContext {
  path: string;
  body: string;
  source: "project" | "parent" | "user";
}

const CONTEXT_FILENAME = "FABLE.md";
const MAX_INCLUDE_DEPTH = 3;
const MAX_BODY_CHARS = 40000;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function stripFrontmatter(raw: string): { body: string; paths?: string[] } {
  if (!raw.startsWith("---")) return { body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { body: raw };
  const front = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const pathsMatch = front.match(/^paths:\s*(.*)$/m);
  let paths: string[] | undefined;
  if (pathsMatch?.[1] !== undefined) {
    const inline = pathsMatch[1].trim().replace(/^\[|\]$/g, "");
    const listed = front.match(/^\s*-\s*(.+)$/gm) ?? [];
    paths = [
      ...inline.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean),
      ...listed.map((s) => s.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean),
    ];
  }
  return paths === undefined ? { body } : { body, paths };
}

async function expandIncludes(body: string, baseDir: string, depth: number): Promise<string> {
  if (depth > MAX_INCLUDE_DEPTH) return body;
  const refs = [...body.matchAll(/^@([^\s\n]+)\s*$/gm)].map((m) => m[1]);
  if (refs.length === 0) return body;
  const parts: string[] = [];
  for (const ref of refs) {
    if (ref === undefined) continue;
    const target = resolve(baseDir, ref);
    if (!(await isFile(target))) {
      parts.push(`(missing include: @${ref})`);
      continue;
    }
    const raw = await readFile(target, "utf8");
    const { body: inner } = stripFrontmatter(raw);
    parts.push(`<!-- @${ref} -->\n${await expandIncludes(inner, dirname(target), depth + 1)}`);
  }
  const withoutRefs = body.replace(/^@([^\s\n]+)\s*$\n?/gm, "");
  return `${withoutRefs}\n${parts.join("\n")}`;
}

async function loadOne(path: string, source: LoadedContext["source"]): Promise<LoadedContext | null> {
  if (!(await isFile(path))) return null;
  const raw = await readFile(path, "utf8");
  const { body } = stripFrontmatter(raw);
  const expanded = await expandIncludes(body, dirname(path), 1);
  return { path, body: expanded.slice(0, MAX_BODY_CHARS), source };
}

export async function loadContext(cwd: string): Promise<LoadedContext[]> {
  const found: LoadedContext[] = [];

  const userPath = join(homedir(), ".fable", CONTEXT_FILENAME);
  const user = await loadOne(userPath, "user");
  if (user) found.push(user);

  const chain: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    chain.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const dirPath of chain) {
    const entry = await loadOne(join(dirPath, CONTEXT_FILENAME), "project");
    if (entry) found.push(entry);
  }

  return found;
}

export function formatContext(entries: LoadedContext[]): string {
  if (entries.length === 0) return "";
  const blocks = entries.map(
    (e) => `<${e.source === "user" ? "user-instructions" : "project-instructions"} path="${e.path}">\n${e.body.trim()}\n</${e.source === "user" ? "user-instructions" : "project-instructions"}>`,
  );
  return `\n\nPROJECT CONTEXT — follow these instructions for this repository:\n${blocks.join("\n\n")}`;
}