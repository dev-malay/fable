import OpenAI from "openai";
import type { ChatMessage } from "@fable/protocol";
import {
  applySummary,
  buildTranscript,
  COMPACT_PROMPT,
  planCompaction,
} from "./compact.js";

const BASE_URL = "https://openrouter.ai/api/v1";
const MAX_SUMMARY_TOKENS = 1200;

export interface CompactOptions {
  model?: string;
  contextBudget: number;
  keepRecent?: boolean;
  apiKey?: string;
}

export interface CompactResult {
  messages: ChatMessage[];
  compacted: boolean;
  foldCount: number;
  summaryChars: number;
}

async function summarize(
  transcript: string,
  model: string,
  apiKey: string,
): Promise<string> {
  const client = new OpenAI({
    baseURL: BASE_URL,
    apiKey,
    defaultHeaders: { "HTTP-Referer": "https://fable.local", "X-Title": "fable" },
  });
  const stream = await client.chat.completions.create({
    model,
    max_tokens: MAX_SUMMARY_TOKENS,
    stream: true,
    messages: [
      { role: "system", content: COMPACT_PROMPT },
      { role: "user", content: transcript },
    ],
  });
  let out = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (typeof delta === "string") out += delta;
  }
  return out.trim();
}

/**
 * Fold older turns into a summary when history exceeds the budget. On any
 * summarizer failure the original history is returned unchanged — compaction is
 * an optimization and must never lose the conversation.
 */
export async function compactHistory(
  messages: ChatMessage[],
  sessionId: string,
  options: CompactOptions,
): Promise<CompactResult> {
  const plan = planCompaction(messages, options.contextBudget);
  if (!plan.shouldCompact) {
    return { messages, compacted: false, foldCount: 0, summaryChars: 0 };
  }

  const fold = messages.slice(0, plan.foldCount);
  const transcript = buildTranscript(fold);
  const model = options.model ?? "";
  const apiKey = options.apiKey ?? "";

  if (model === "" || apiKey === "") {
    return { messages, compacted: false, foldCount: plan.foldCount, summaryChars: 0 };
  }

  try {
    const summary = await summarize(transcript, model, apiKey);
    if (summary === "") {
      return { messages, compacted: false, foldCount: plan.foldCount, summaryChars: 0 };
    }
    return {
      messages: applySummary(messages, summary, sessionId),
      compacted: true,
      foldCount: plan.foldCount,
      summaryChars: summary.length,
    };
  } catch {
    return { messages, compacted: false, foldCount: plan.foldCount, summaryChars: 0 };
  }
}