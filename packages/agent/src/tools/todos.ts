import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { str, type ToolDef, type ToolInput } from "./types.js";

const STATUSES = ["pending", "in_progress", "completed"];

export interface Todo {
  content: string;
  status: string;
  priority: string;
}

const TODOS_DIR = join(homedir(), ".fable");
const TODOS_FILE = join(TODOS_DIR, "todos.json");

let store: Todo[] = [];
let loaded = false;

function todosPath(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "root";
  return join(TODOS_DIR, "todos", `${slug}.json`);
}

async function load(cwd: string): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(todosPath(cwd), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) store = parsed as Todo[];
  } catch {
    store = [];
  }
}

async function persist(cwd: string): Promise<void> {
  await mkdir(join(TODOS_DIR, "todos"), { recursive: true });
  await writeFile(todosPath(cwd), JSON.stringify(store, null, 2), "utf8");
}

export function getTodos(): Todo[] {
  return store;
}

function parseTodos(input: ToolInput): Todo[] {
  const raw = input["todos"];
  if (!Array.isArray(raw)) throw new Error('input "todos" must be an array');
  if (raw.length > 20) throw new Error("max 20 todos");

  return raw.map((item: unknown) => {
    if (typeof item !== "object" || item === null) throw new Error("each todo needs content + status");
    const record = item as Record<string, unknown>;
    const content = str(record, "content") ?? "";
    const status = str(record, "status") ?? "";
    if (content.trim() === "") throw new Error("each todo needs content");
    if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
    const priority = typeof record["priority"] === "string" ? record["priority"] : "medium";
    return { content, status, priority };
  });
}

export const todoWriteTool: ToolDef = {
  name: "TodoWrite",
  description: "Replace the task list for this project. Use for multi-step work so progress stays visible.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: STATUSES },
            priority: { type: "string" },
          },
          required: ["content", "status"],
          additionalProperties: false
        }
      }
    },
    required: ["todos"],
    additionalProperties: false
  },
  needsApproval: false,
  summarize: (input) => {
    const raw = input["todos"];
    return Array.isArray(raw) ? `${raw.length} todos` : "";
  },
  execute: async (input, ctx) => {
    await load(ctx.cwd);
    store = parseTodos(input);
    await persist(ctx.cwd);
    return store.map((t) => `- [${t.status}] ${t.content}`).join("\n");
  }
};