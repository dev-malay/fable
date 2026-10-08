import OpenAI from "openai";
import type { Session, TokenUsage, ToolEvent, ChatMessage, PermissionDecision, PermissionRule, PermissionMode } from "@fable/protocol";
import { executeTool, safeSummarize, TOOL_MAP, toOpenAITools } from "./tools/registry.js";
import type { ToolContext, ToolInput } from "./tools/types.js";
import { CODING_SYSTEM_PROMPT } from "./repl.js";
import { sessionStore } from "./session.js";
import { permissionEngine, PermissionEngine } from "./permissions.js";
import { formatContext, loadContext } from "./context.js";
import { formatSkills, loadSkills } from "./skills.js";
import { compactHistory } from "./compaction.js";
import { DEFAULT_CONTEXT_BUDGET } from "./compact.js";

export const ENGINE = "openrouter" as const;
export const VERSION = "0.1.0";
export const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
export const DEFAULT_MAX_TURNS = 15;

const BASE_URL = "https://openrouter.ai/api/v1";
const MAX_TOKENS = 2048;
const SYSTEM_PROMPT = CODING_SYSTEM_PROMPT;

export function resolveModel(override?: string): string {
  if (override !== undefined && override.trim() !== "") return override.trim();
  const fromEnv = process.env.FABLE_MODEL;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  return DEFAULT_MODEL;
}

export interface RunOptions {
  model?: string;
  maxTurns?: number;
  cwd?: string;
  skipPermissions?: boolean;
  permissionMode?: PermissionMode;
  history?: ChatMessage[];
  extraContext?: string;
  contextBudget?: number;
  sessionId?: string;
  onCompact?: (info: { foldCount: number; summaryChars: number }) => void;
  onUsage?: (usage: TokenUsage) => void;
  onToolEvent?: (event: ToolEvent) => void;
  onRetry?: (info: { attempt: number; waitMs: number; reason: string }) => void;
  onPermissionPrompt?: (tool: string, summary: string, input: Record<string, unknown>) => Promise<"allow" | "deny">;
}

function readApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (key === undefined || key.trim() === "") {
    throw new Error("OPENROUTER_API_KEY is not set — add it to .env (see .env.example)");
  }
  return key.trim();
}

function describeError(error: unknown): string {
  const status = (error as { status?: unknown }).status;
  if (status === 401) return "OpenRouter rejected the key (401) — check OPENROUTER_API_KEY";
  if (status === 402) return "OpenRouter out of credits (402)";
  if (status === 429) return "OpenRouter rate limit (429) — free tier, wait and retry";
  return error instanceof Error ? error.message : "unknown error";
}

export function createSession(
  title = "Untitled session",
  options: { cwd?: string; model?: string; maxTurns?: number; skipPermissions?: boolean } = {}
): Session {
  return {
    id: crypto.randomUUID(),
    title,
    createdAt: new Date().toISOString(),
    cwd: options.cwd ?? process.cwd(),
    model: options.model ?? resolveModel(),
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    skipPermissions: options.skipPermissions ?? false,
  };
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

function parseInput(raw: string): ToolInput {
  const value: unknown = JSON.parse(raw === "" ? "{}" : raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("tool arguments must be a JSON object");
  }
  return value as ToolInput;
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

export async function* runPrompt(prompt: string, options: RunOptions = {}): AsyncGenerator<string> {
  if (prompt.trim() === "") throw new Error('empty prompt — usage: fable -p "hello"');
  await permissionEngine.load();
  if (options.permissionMode) {
    permissionEngine.setMode(options.permissionMode);
  }
  const client = new OpenAI({
    baseURL: BASE_URL,
    apiKey: readApiKey(),
    defaultHeaders: { "HTTP-Referer": "https://fable.local", "X-Title": "fable" },
  });
  const model = resolveModel(options.model);
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const ctx: ToolContext = {
    cwd: options.cwd ?? process.cwd(),
    skipPermissions: options.skipPermissions ?? false,
    alwaysAllowed: new Set<string>(),
  };
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT + (options.extraContext ?? "") },
  ];

  let priorTurns = options.history ?? [];
  if (priorTurns.length > 0) {
    const result = await compactHistory(priorTurns, options.sessionId ?? "adhoc", {
      model,
      apiKey: readApiKey(),
      contextBudget: options.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
    });
    if (result.compacted) {
      options.onCompact?.({ foldCount: result.foldCount, summaryChars: result.summaryChars });
    }
    priorTurns = result.messages;
  }
  for (const prior of priorTurns) {
    if (prior.content.trim() === "") continue;
    messages.push({ role: prior.role, content: prior.content })
  }
  messages.push({ role: "user", content: prompt });
  // console.log("messages", messages)
  for (let turn = 1; ; turn += 1) {
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    for (let attempt = 1; ; attempt += 1) {
      try {
        stream = await client.chat.completions.create({
          model,
          max_tokens: MAX_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
          tools: toOpenAITools(),
          messages,
        });
        break;
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (status === 429 && attempt < 4) {
          const waitMs = attempt * 4000;
          options.onRetry?.({ attempt, waitMs, reason: "rate limited" });
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw new Error(describeError(error));
      }
    }
    // console.log("stream", stream)
    const calls = new Map<number, PendingCall>();
    let assistantText = "";
    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (typeof delta?.content === "string" && delta.content !== "") {
          assistantText += delta.content;
          yield delta.content;
        }
        for (const part of delta?.tool_calls ?? []) {
          const slot = calls.get(part.index) ?? { id: "", name: "", args: "" };
          if (part.id) slot.id = part.id;
          if (part.function?.name) slot.name += part.function.name;
          if (part.function?.arguments) slot.args += part.function.arguments;
          calls.set(part.index, slot);
        }
        if (chunk.usage && options.onUsage) {
          options.onUsage({
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          });
        }
      }
    } catch (error) {
      throw new Error(describeError(error));
    }
    if (calls.size === 0) return;
    if (turn >= maxTurns) throw new Error(`stopped after ${maxTurns} tool turns (raise --max-turns)`);
    const ordered = [...calls.values()].map((call, i) => ({
      id: call.id === "" ? `call_${turn}_${i}` : call.id,
      name: call.name,
      args: call.args,
    }));
    const toolMessages: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];
    for (const call of ordered) {
      const def = TOOL_MAP.get(call.name);
      if (!def) {
        options.onToolEvent?.({ type: "tool.result", name: call.name, ok: false, preview: "unknown tool", permission: "skipped" });
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: `ERROR: unknown tool "${call.name}"` });
        continue;
      }
      let input: ToolInput;
      try {
        input = parseInput(call.args);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid arguments";
        options.onToolEvent?.({ type: "tool.result", name: def.name, ok: false, preview: message, permission: "skipped" });
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: `ERROR: ${message}` });
        continue;
      }
      const decision = permissionEngine.evaluate(def.name, input);
      const permissionEvent: "auto" | "asked" | "skipped" = decision === "ask" ? "asked" : decision === "allow" ? "auto" : "skipped";
      options.onToolEvent?.({ type: "tool.start", name: def.name, summary: safeSummarize(def, input), permission: permissionEvent });

      let ok = false;
      let result = "";
      if (decision === "allow") {
        const execResult = await executeTool(def, input, ctx);
        ok = execResult.ok;
        result = execResult.result;
      } else if (decision === "deny") {
        ok = false;
        result = `DENIED: ${def.name} not allowed by permission rules`;
      } else {
        // decision === ask
        if (options.onPermissionPrompt) {
          const userDecision = await options.onPermissionPrompt(def.name, safeSummarize(def, input), input);
          if (userDecision === "allow") {
            const execResult = await executeTool(def, input, ctx);
            ok = execResult.ok;
            result = execResult.result;
          } else {
            ok = false;
            result = `DENIED by user: ${def.name} was not approved`;
          }
        } else {
          ok = false;
          result = `DENIED: ${def.name} needs approval — re-run in a terminal or with --permission-mode bypass`;
        }
      }
      options.onToolEvent?.({ type: "tool.result", name: def.name, ok, preview: result.slice(0, 160), permission: permissionEvent });
      if (ok) {
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: result });
      } else {
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    messages.push({
      role: "assistant",
      content: assistantText === "" ? null : assistantText,
      tool_calls: ordered.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.args },
      })),
    });
    messages.push(...toolMessages);
  }
}

export async function resumeSession(
  sessionId: string,
  options: RunOptions = {}
): Promise<{ session: Session; messages: ChatMessage[] } | null> {
  const loaded = await sessionStore.load(sessionId);
  if (!loaded) return null;
  return { session: loaded.meta, messages: loaded.messages };
}

export async function buildContext(cwd: string): Promise<string> {
  const [entries, skills] = await Promise.all([loadContext(cwd), loadSkills(cwd)]);
  return formatContext(entries) + formatSkills(skills);
}

export { sessionStore } from "./session.js";
export { runRepl } from "./repl.js";
export { permissionEngine, PermissionEngine } from "./permissions.js";
export { loadContext, formatContext, type LoadedContext } from "./context.js";
export { loadSkills, getSkill, type Skill } from "./skills.js";
export { COMMANDS, COMMAND_MAP, commandHelp, type CommandDef } from "./commands.js";
export { initContext } from "./init.js";
export { compactHistory, type CompactOptions, type CompactResult } from "./compaction.js";
export {
  DEFAULT_CONTEXT_BUDGET,
  KEEP_RECENT_TURNS,
  estimateTokens,
  estimateMessagesTokens,
  isOverBudget,
  planCompaction,
  buildTranscript,
  applySummary,
} from "./compact.js";
export type { PermissionMode, PermissionRule, PermissionDecision } from "@fable/protocol";