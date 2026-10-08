import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { int, resolveInCwd, str, type ToolDef } from "./types.js";

const MAX_RESULTS = 100;

export function globToRegExp(pattern: string): RegExp {
  const fixed = pattern.replaceAll("\\", "/");
  let out = "";
  let i = 0;
  while (i < fixed.length) {
    const c = fixed[i];
    if (c === "*") {
      if (fixed[i + 1] === "*") {
        out += ".*";
        i += fixed[i + 2] === "/" ? 3 : 2;
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (c === undefined) {
      i += 1;
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === "dist" ||
      entry.name === ".next"
    ) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

function rel(cwd: string, full: string): string {
  return relative(cwd, full).replaceAll("\\", "/");
}

export const readTool: ToolDef = {
  name: "Read",
  description: "Read a text file, optionally from an offset line with a line limit.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the working directory" },
      offset: { type: "integer", description: "First line to read, 1-based (default 1)" },
      limit: { type: "integer", description: "Max lines to read (default 200)" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  needsApproval: false,
  summarize: (input) => str(input, "path") ?? "",
  execute: async (input, ctx) => {
    const file = resolveInCwd(ctx.cwd, str(input, "path") ?? "");
    const offset = int(input, "offset", 1);
    const limit = int(input, "limit", 200);
    if (offset < 1 || limit < 1) throw new Error("offset and limit must be >= 1");
    const lines = (await readFile(file, "utf8")).split("\n");
    if (offset > lines.length) throw new Error(`offset beyond end of file (${lines.length} lines)`);
    return lines
      .slice(offset - 1, offset - 1 + limit)
      .map((line, i) => `${offset + i}: ${line}`).join("\n");
  }
};

export const globTool: ToolDef = {
  name: "Glob",
  description: "Find files by glob pattern (*, **, ?). Skips node_modules, .git, dist.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob like src/**/*.ts" },
    },
    required: ["pattern"],
    additionalProperties: false
  },
  needsApproval: false,
  summarize: (input) => str(input, "pattern") ?? "",
  execute: async (input, ctx) => {
    const rx = globToRegExp(str(input, "pattern") ?? "");
    const all: string[] = [];
    await walk(ctx.cwd, all);
    const hits = all
      .map((full) => rel(ctx.cwd, full))
      .filter((name) => rx.test(name))
      .sort()
      .slice(0, MAX_RESULTS);
    return hits.length > 0 ? hits.join("\n") : "no matches";
  }
};

export const grepTool: ToolDef = {
  name: "Grep",
  description: "Search file contents with a JavaScript regex. Prints path:line matches.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex source, e.g. TODO|FIXME" },
      include: { type: "string", description: "Only files matching this glob" },
      path: { type: "string", description: "File or directory to search (default working directory)" },
    },
    required: ["pattern"],
    additionalProperties: false
  },
  needsApproval: false,
  summarize: (input) => str(input, "pattern") ?? "",
  execute: async (input, ctx) => {
    let rx: RegExp;
    try {
      rx = new RegExp(str(input, "pattern") ?? "");
    } catch {
      throw new Error("invalid regex pattern");
    }
    const include = str(input, "include", false);
    const incRx = include === undefined ? null : globToRegExp(include);
    const scopeRaw = str(input, "path", false);
    const scope = scopeRaw === undefined ? ctx.cwd : resolveInCwd(ctx.cwd, scopeRaw);
    const candidates: string[] = [];
    try {
      const stat = await readFile(scope, "utf8").then(
        () => "file" as const,
        () => "dir" as const,
      );
      if (stat === "file") candidates.push(scope);
      else await walk(scope, candidates);
    } catch {
      throw new Error(`cannot search: ${scopeRaw ?? "."}`);
    }
    const hits: string[] = [];
    for (const full of candidates) {
      if (hits.length >= 50) break;
      if (incRx && !incRx.test(rel(ctx.cwd, full))) continue;
      let text: string;
      try {
        text = await readFile(full, "utf8");
      } catch {
        continue;
      }
      if (text.slice(0, 4096).includes("\0")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line !== undefined && rx.test(line)) {
          hits.push(`${rel(ctx.cwd, full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          if (hits.length >= 50) break;
        }
      }
    }

    return hits.length > 0 ? hits.join("\n") : "no matches";
  }
};
