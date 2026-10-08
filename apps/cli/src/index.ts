#!/usr/bin/env bun
import {
  DEFAULT_MAX_TURNS,
  ENGINE,
  resolveModel,
  runPrompt,
  runRepl,
  permissionEngine,
  buildContext,
  DEFAULT_CONTEXT_BUDGET,
  commandHelp,
  initContext,
  PermissionMode,
} from "@fable/agent";
import type { TokenUsage, ToolEvent } from "@fable/protocol";
import { handlePermissionPrompt } from "./permissions.js";

const VERSION = "0.1.0";
const SERVER_URL = "http://localhost:3101";

type OutputFormat = "text" | "json";

interface ToolTrace {
  name: string;
  ok: boolean;
  preview: string;
}

function cliIsInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}


function printHelp(): void {
  console.log(`fable ${VERSION} - coding agent

Usage:
  fable                       Start interactive REPL (requires TTY)
  fable --continue            Resume the most recent session
  fable --resume [id]         Resume a specific session (or pick from list)
  fable --session-id <id>     Start new session with specific ID
  fable --init                Scaffold FABLE.md in the current directory
  fable --version             Print version
  fable --help                Show this help
  fable --health              Check the local server (/health)
  fable -p, --print <prompt>  Run one prompt through the engine and exit

Slash commands (in the REPL):
${commandHelp()}

Options:
  --model <id>                    Model override (default: FABLE_MODEL or built-in)
  --output-format <text|json>     Output shape for -p (default: text)
  --max-turns <n>                 Max tool turns per run (default ${DEFAULT_MAX_TURNS})
  --permission-mode <mode>        Permission mode: default, acceptEdits, plan, bypass (default: default)
  --allow-tool <tool[@pattern]>   Allow a tool (optionally with glob pattern for Bash)
  --deny-tool <tool[@pattern]>    Deny a tool (optionally with glob pattern for Bash)
  --dangerously-skip-permissions  Approve all tools without asking (alias for --permission-mode bypass)
  --context-budget <tokens>        Auto-compact history above this many tokens

Examples:
  fable
  fable --continue
  fable --resume
  fable --resume abc123
  fable -p "hello fable"
  fable -p "list src files" --max-turns 5
  fable -p "hi" --output-format json
  fable --health
  fable -p "edit file" --permission-mode acceptEdits
  fable -p "run tests" --allow-tool "Bash@npm test"
  fable -p "clean" --deny-tool "Bash@rm -rf *"
  fable --permission-mode plan`);
}

async function cmdHealth(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}/health`);
  } catch {
    throw new Error(`server unreachable at ${SERVER_URL} (is "turbo run dev" running?)`);
  }
  if (!res.ok) throw new Error(`server unhealthy: HTTP ${res.status}`);
  const body: unknown = await res.json();
  console.log(JSON.stringify(body));
}

function showToolEvent(event: ToolEvent): void {
  if (event.type === "tool.start") {
    const perm = event.permission ? ` [${event.permission}]` : "";
    process.stderr.write(`● ${event.name}${perm} ${event.summary}\n`);
  } else {
    const prefix = event.ok ? "\x1b[32m  → ok\x1b[0m" : "\x1b[31m  → FAILED\x1b[0m";
    process.stderr.write(`${prefix} \x1b[90m${event.preview.split("\n")[0] ?? ""}\x1b[0m\n`);
  }
}

async function cmdInit(): Promise<void> {
  const { path, created } = await initContext(process.cwd());
  if (created) {
    console.log(`created ${path}`);
    console.log("Edit it to describe your build commands and conventions.");
  } else {
    console.log(`${path} already exists — left untouched`);
  }
}

async function cmdPrint(
  prompt: string,
  model: string | undefined,
  format: OutputFormat,
  maxTurns: number,
  skipPermissions: boolean,
  permissionMode: PermissionMode,
  allowTools: Array<{ tool: string; pattern?: string }>,
  denyTools: Array<{ tool: string; pattern?: string }>,
  contextBudget: number,
): Promise<void> {
  await permissionEngine.load();
  if (permissionMode) permissionEngine.setMode(permissionMode);
  for (const rule of allowTools) {
    await permissionEngine.addRule({ tool: rule.tool, pattern: rule.pattern, decision: "allow" });
  }
  for (const rule of denyTools) {
    await permissionEngine.addRule({ tool: rule.tool, pattern: rule.pattern, decision: "deny" });
  }

  const extraContext = await buildContext(process.cwd());
  const permissionPrompt = cliIsInteractive() && !skipPermissions
    ? async (tool: string, summary: string, input: Record<string, unknown>) => {
        return handlePermissionPrompt(tool, summary, input);
      }
    : undefined;

  if (format === "text") {
    for await (const delta of runPrompt(prompt, {
      model,
      maxTurns,
      skipPermissions,
      permissionMode,
      extraContext,
      contextBudget,
      onToolEvent: showToolEvent,
      onPermissionPrompt: permissionPrompt,
    })) {
      process.stdout.write(delta);
    }
    process.stdout.write("\n");
    return;
  }
  let content = "";
  let usage: TokenUsage | null = null;
  const tools: ToolTrace[] = [];
  for await (const delta of runPrompt(prompt, {
    model,
    maxTurns,
    skipPermissions,
    permissionMode,
    extraContext,
    contextBudget,
    onUsage: (u) => {
      usage = u;
    },
    onToolEvent: (event) => {
      if (event.type === "tool.result") {
        tools.push({ name: event.name, ok: event.ok, preview: event.preview });
      }
    },
    onPermissionPrompt: permissionPrompt,
  })) {
    content += delta;
  }
  console.log(JSON.stringify({ content, model: resolveModel(model), usage, tools }));
}

function parseMaxTurns(value: string | undefined): number {
  if (value === undefined || value === "") throw new Error("--max-turns needs a value");
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error("--max-turns must be a positive integer");
  return n;
}

function parseToolSpec(spec: string): { tool: string; pattern?: string } {
  const atIndex = spec.indexOf("@");
  if (atIndex === -1) return { tool: spec };
  return { tool: spec.slice(0, atIndex), pattern: spec.slice(atIndex + 1) };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const head = args[0];

  let model: string | undefined;
  let maxTurns = DEFAULT_MAX_TURNS;
  let skipPermissions = false;
  let sessionId: string | undefined;
  let shouldResume = false;
  let shouldContinue = false;
  let format: OutputFormat = "text";
  // contextBudget parsed below
  let permissionMode: PermissionMode = "default";
  let contextBudget = DEFAULT_CONTEXT_BUDGET;
  const allowTools: Array<{ tool: string; pattern?: string }> = [];
  const denyTools: Array<{ tool: string; pattern?: string }> = [];

  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--model") {
      const value = rest[i + 1];
      if (value === undefined || value === "") throw new Error("--model needs a value");
      model = value;
      i++;
    } else if (arg === "--output-format") {
      const value = rest[i + 1];
      if (value !== "text" && value !== "json") {
        throw new Error('--output-format must be "text" or "json"');
      }
      format = value;
      i++;
    } else if (arg === "--max-turns") {
      maxTurns = parseMaxTurns(rest[i + 1]);
      i++;
    } else if (arg === "--permission-mode") {
      const value = rest[i + 1];
      if (value === undefined || value === "") throw new Error("--permission-mode needs a value");
      if (!["default", "acceptEdits", "plan", "bypass"].includes(value)) {
        throw new Error('--permission-mode must be one of: default, acceptEdits, plan, bypass');
      }
      permissionMode = value as PermissionMode;
      i++;
    } else if (arg === "--allow-tool") {
      const value = rest[i + 1];
      if (value === undefined || value === "") throw new Error("--allow-tool needs a value");
      allowTools.push(parseToolSpec(value));
      i++;
    } else if (arg === "--deny-tool") {
      const value = rest[i + 1];
      if (value === undefined || value === "") throw new Error("--deny-tool needs a value");
      denyTools.push(parseToolSpec(value));
      i++;
    } else if (arg === `--context-budget`) {
      const raw = rest[i + 1];
      const n = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(n) || n < 1000) throw new Error(`--context-budget must be an integer >= 1000`);
      contextBudget = n;
      i++;
    } else if (arg === "--dangerously-skip-permissions") {
      skipPermissions = true;
      permissionMode = "bypass";
    } else if (arg === "--session-id") {
      const value = rest[i + 1];
      if (value === undefined || value === "") throw new Error("--session-id needs a value");
      sessionId = value;
      i++;
    }
  }

const permissionPrompt = cliIsInteractive()
    ? async (tool: string, summary: string, input: Record<string, unknown>) => {
      await permissionEngine.load();
      return handlePermissionPrompt(tool, summary, input);
    }
    : undefined;

if (head === undefined) {
    if (!cliIsInteractive()) {
      throw new Error("interactive REPL requires a TTY — use -p/--print for non-interactive use");
    }
    await permissionEngine.load();
    await runRepl({
      model,
      maxTurns,
      skipPermissions,
      permissionMode,
      contextBudget,
      sessionId,
      resume: shouldResume,
      onPermissionPrompt: permissionPrompt,
    });
    return;
  }

  if (head === "--help" || head === "-h") {
    printHelp();
    return;
  }
  if (head === "--version" || head === "-v") {
    console.log(`${VERSION} (fable, engine=${ENGINE})`);
    return;
  }
  if (head === "--health") {
    await cmdHealth();
    return;
  }
  if (head === "--init") {
    await cmdInit();
    return;
  }
  if (head === "--continue") {
    shouldContinue = true;
    if (!cliIsInteractive()) {
      throw new Error("--continue requires a TTY");
    }
    await permissionEngine.load();
    await runRepl({
      model,
      maxTurns,
      skipPermissions,
      permissionMode,
      resume: true,
      onPermissionPrompt: permissionPrompt,
    });
    return;
  }
  if (head === "--resume") {
    shouldResume = true;
    if (!cliIsInteractive()) {
      throw new Error("--resume requires a TTY");
    }
    const resumeId = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
    await permissionEngine.load();
    await runRepl({
      model,
      maxTurns,
      skipPermissions,
      permissionMode,
      sessionId: resumeId,
      resume: true,
      onPermissionPrompt: permissionPrompt,
    });
    return;
  }
  if (head === "--session-id") {
    throw new Error("--session-id is an option, not a command. Use: fable --session-id <id>");
  }
  if (head === "-p" || head === "--print") {
    const promptParts: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg !== undefined) {
        promptParts.push(arg);
      }
    }
    await cmdPrint(
      promptParts.join(" "),
      model,
      format,
      maxTurns,
      skipPermissions,
      permissionMode,
      allowTools,
      denyTools,
      contextBudget,
    );
    return;
  }
  throw new Error(`unknown command "${head}" — see fable --help`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`fable: ${message}`);
  process.exit(1);
});
