import { createInterface, Interface } from "node:readline";
import {
  DEFAULT_MAX_TURNS,
  runPrompt,
  createSession,
  resolveModel,
  sessionStore,
  resumeSession,
  permissionEngine,
} from "./index.js";
import type { TokenUsage, ToolEvent, Session, ChatMessage, PermissionMode } from "@fable/protocol";

export const CODING_SYSTEM_PROMPT = `You are fable, a coding agent that works directly in this repository.

CORE WORKFLOW — follow for EVERY task:
1. EXPLORE first. Use Read/Glob/Grep to understand the codebase before editing.
2. PLAN with TodoWrite. Break multi-step work into todos; update as you go.
3. EDIT precisely. Use exact strings; prefer small, focused changes.
4. VERIFY after edits. Run the project's check commands (build, types, lint) and read the output.
5. FIX failures. If verification fails, read the error, understand it, and retry.

RULES:
- Never guess file contents — always Read first.
- Never leave broken code — if a check fails, fix it before moving on.
- Keep changes minimal and surgical.
- Ask for clarification if the task is ambiguous.
- Use Bash to run commands, not to edit files.
- TodoWrite is your memory — update it aggressively.`;

const PROMPT = "\x1b[96mfable>\x1b[0m ";
const CONTINUATION = "\x1b[90m...\x1b[0m ";

type SlashHandler = (arg: string, ctx: ReplContext) => Promise<void>;

interface ReplContext {
  session: Session;
  cwd: string;
  model: string;
  maxTurns: number;
  skipPermissions: boolean;
  history: string[];
  rl: Interface;
  messages: ChatMessage[];
  tools: ToolEvent[];
}

function printBanner(): void {
  console.log(`
\x1b[38;2;100;200;255mfable \x1b[90mv0.1.0\x1b[0m
\x1b[90m────────────────────────────────────────\x1b[0m
  Type \x1b[1m/help\x1b[0m for commands  |  Ctrl+C to interrupt  |  Ctrl+D to exit
`);
}

function printHelp(): void {
  console.log(`
Commands:
  /help           Show this help
  /clear          Clear screen
  /compact        Summarize conversation and start fresh
  /model <id>     Switch model (current: {{model}})
  /max-turns <n>  Set max tool turns (default 10)
  /skip-perms     Toggle --dangerously-skip-permissions
  /status         Show session info
  /exit           Exit fable
  /quit           Same as /exit
`);
}

function clearScreen(): void {
  console.log("\x1b[2J\x1b[H");
}

async function handleSlash(line: string, ctx: ReplContext): Promise<boolean> {
  const [cmdRaw, ...rest] = line.slice(1).split(" ");
  const cmd = cmdRaw ?? "help";
  const arg = rest.join(" ").trim();
  const handlers: Record<string, SlashHandler> = {
    help: async () => {
      printHelp();
      console.log(`\x1b[90mCurrent model:\x1b[0m ${ctx.model}`);
    },
    clear: async () => clearScreen(),
    compact: async () => {
      console.log("\x1b[90m[compact not yet implemented - clears local history only]\x1b[0m");
      ctx.history = [];
      ctx.messages = [];
      ctx.tools = [];
    },
    model: async () => {
      if (!arg) {
        console.log(`Current model: ${ctx.model}`);
      } else {
        ctx.model = arg;
        console.log(`Model set to: ${arg}`);
      }
    },
    "max-turns": async () => {
      if (!arg) {
        console.log(`Max turns: ${ctx.maxTurns}`);
      } else {
        const n = Number(arg);
        if (!Number.isInteger(n) || n < 1) {
          console.log("Usage: /max-turns <positive integer>");
        } else {
          ctx.maxTurns = n;
          console.log(`Max turns set to: ${n}`);
        }
      }
    },
    "skip-perms": async () => {
      ctx.skipPermissions = !ctx.skipPermissions;
      console.log(`Permission prompts: ${ctx.skipPermissions ? "SKIPPED" : "ENABLED"}`);
    },
    status: async () => {
      console.log(`Session: ${ctx.session.id.slice(0, 8)}...`);
      console.log(`CWD: ${ctx.cwd}`);
      console.log(`Model: ${ctx.model}`);
      console.log(`Max turns: ${ctx.maxTurns}`);
      console.log(`Skip perms: ${ctx.skipPermissions}`);
      console.log(`Messages: ${ctx.messages.length}`);
    },
    exit: async () => {
      ctx.rl.close();
    },
    quit: async () => {
      ctx.rl.close();
    },
  };
  const handler = handlers[cmd] ?? handlers.help;
  if (!handler) {
    console.log(`Unknown command: /${cmd} - type /help`);
    return true;
  }
  try {
    await handler(arg, ctx);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.log(`\x1b[31mError: ${msg}\x1b[0m`);
  }
  return true;
}

function toChatMessage(role: "user" | "assistant", content: string, sessionId: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    sessionId,
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

async function saveSession(ctx: ReplContext): Promise<void> {
  const meta = {
    ...ctx.session,
    cwd: ctx.cwd,
    model: ctx.model,
    maxTurns: ctx.maxTurns,
    skipPermissions: ctx.skipPermissions,
  };
  await sessionStore.save(meta, ctx.messages, ctx.tools);
}

export async function runRepl(options: {
  model?: string;
  maxTurns?: number;
  skipPermissions?: boolean;
  permissionMode?: PermissionMode;
  cwd?: string;
  sessionId?: string;
  resume?: boolean;
  onPermissionPrompt?: (tool: string, summary: string, input: Record<string, unknown>) => Promise<"allow" | "deny">;
}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const model = resolveModel(options.model);
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const skipPermissions = options.skipPermissions ?? false;
  const permissionMode = options.skipPermissions ? "bypass" : (options.permissionMode ?? "default");
  await permissionEngine.load();
  permissionEngine.setMode(permissionMode);

  let session: Session;
  let messages: ChatMessage[] = [];
  let tools: ToolEvent[] = [];

  if (options.resume && options.sessionId) {
    const loaded = await resumeSession(options.sessionId, {
      model: options.model,
      maxTurns: options.maxTurns,
      skipPermissions: options.skipPermissions,
      cwd: options.cwd
    });
    if (loaded) {
      session = loaded.session;
      messages = loaded.messages;
      console.log(`\x1b[32mResumed session ${session.id.slice(0, 8)}... (${messages.length} messages)\x1b[0m`);
    } else {
      console.log(`\x1b[31mSession ${options.sessionId} not found, starting new\x1b[0m`);
      session = createSession("REPL session", { cwd, model, maxTurns, skipPermissions });
    }
  } else if (options.resume && !options.sessionId) {
    const sessions = await sessionStore.list()
    if (sessions.length === 0) 
      {
      console.log("\x1b[33mNo previous sessions found, starting new\x1b[0m");
      session = createSession("REPL session", { cwd, model, maxTurns, skipPermissions });
    } 
    else 
      {
      const latest = sessions[0];
      if (!latest) {
        session = createSession("REPL session", { cwd, model, maxTurns, skipPermissions });
      } else {
        const loaded = await resumeSession(latest.id, {
        model: options.model,
        maxTurns: options.maxTurns,
        skipPermissions: options.skipPermissions,
        cwd: options.cwd
      });
      if (loaded) {
          session = loaded.session;
          messages = loaded.messages;
          console.log(`\x1b[32mResumed latest session ${session.id.slice(0, 8)}... (${messages.length} messages)\x1b[0m`);
        } else {
          session = createSession("REPL session", { cwd, model, maxTurns, skipPermissions });
        }
      }
    }
  } else {
    session = createSession("REPL session", { cwd, model, maxTurns, skipPermissions });
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 1000,
    prompt: PROMPT
  });

  const ctx: ReplContext = {
    session,
    cwd,
    model,
    maxTurns,
    skipPermissions,
    history: [],
    rl,
    messages,
    tools
  };

  printBanner();
  console.log(`\x1b[90mCWD:\x1b[0m ${cwd}`);
  console.log(`\x1b[90mModel:\x1b[0m ${model}`);
  console.log(`\x1b[90mMax turns:\x1b[0m ${maxTurns}`);
  console.log(`\x1b[90mSkip perms:\x1b[0m ${skipPermissions}`);
  console.log(`\x1b[90mPerm mode:\x1b[0m ${permissionMode}`);
  console.log(`\x1b[90mSession:\x1b[0m ${session.id.slice(0, 8)}...`);
  if (messages.length > 0) 
    {
      console.log(`\x1b[90mRestored:\x1b[0m ${messages.length} messages`)
    }
  console.log("");

  const onToolEvent = (event: ToolEvent): void => {
    if (event.type === "tool.start") {
      console.log(`\x1b[33m● ${event.name}\x1b[0m \x1b[90m${event.summary}\x1b[0m`);
    } else {
      const prefix = event.ok ? "\x1b[32m  → ok\x1b[0m" : "\x1b[31m  → FAILED\x1b[0m";
      console.log(`${prefix} \x1b[90m${event.preview.split("\n")[0] ?? ""}\x1b[0m`);
    }
    ctx.tools.push(event)
  };

  let closing = false;

  return new Promise((resolve) => {
    const readLine = (continuation = false): void => {
      if (closing) return;
      rl.setPrompt(continuation ? CONTINUATION : PROMPT);
      rl.prompt();
    };

    rl.on("line", async (line: string) => {
      const trimmed = line.trim();
      if (trimmed === "") {
        readLine();
        return;
      }
      if (trimmed.startsWith("/")) {
        const handled = await handleSlash(trimmed, ctx);
        if (handled) {
          if (!closing) readLine();
          return;
        }
      }
      ctx.history.push(trimmed);
      const priorHistory = [...ctx.messages];
      ctx.messages.push(toChatMessage("user", trimmed, ctx.session.id));
      try {
        let assistantText = "";
        for await (const delta of runPrompt(trimmed, {
          model: ctx.model,
          maxTurns: ctx.maxTurns,
          skipPermissions: ctx.skipPermissions,
          permissionMode,
          history: priorHistory,
          cwd: ctx.cwd,
          onToolEvent,
          onRetry: ({ attempt, waitMs }) => {
            console.log(`\x1b[33mfable\x1b[0m \x1b[90mrate limited — retry ${attempt} in ${Math.round(waitMs / 1000)}s\x1b[0m`);
          },
          onPermissionPrompt: options.onPermissionPrompt,
        })) {
          assistantText += delta;
          process.stdout.write(delta);
        }
        process.stdout.write("\n");
        if (assistantText) {
          ctx.messages.push(toChatMessage("assistant", assistantText, ctx.session.id));
        }
        await saveSession(ctx);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "unknown error";
        console.log(`\x1b[31mError: ${msg}\x1b[0m`);
        await saveSession(ctx);
      }
      if (!closing) readLine();
    });

    rl.on("SIGINT", () => {
      if (closing) return;
      rl.close();
    });

    rl.on("close", async () => {
      closing = true;
      await saveSession(ctx);
      console.log("bye");
      resolve();
    });

    readLine();
  });
  
}