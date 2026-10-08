import type { ChatMessage } from "@fable/protocol";

export const DEFAULT_CONTEXT_BUDGET = 120_000;
export const KEEP_RECENT_TURNS = 6;
const CHARS_PER_TOKEN = 4;
const SUMMARY_PREFIX = "[compacted earlier conversation]";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content) + 8;
  return total;
}

export function isOverBudget(messages: ChatMessage[], budget: number): boolean {
  return estimateMessagesTokens(messages) > budget;
}

function foldableMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= KEEP_RECENT_TURNS) return [];
  return messages.slice(0, messages.length - KEEP_RECENT_TURNS);
}

function keptMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= KEEP_RECENT_TURNS) return messages;
  return messages.slice(messages.length - KEEP_RECENT_TURNS);
}

export interface CompactionPlan {
  shouldCompact: boolean;
  foldCount: number;
  keepCount: number;
  foldChars: number;
}

/** Decide whether history needs folding, without calling a model. */
export function planCompaction(messages: ChatMessage[], budget: number): CompactionPlan {
  const fold = foldableMessages(messages);
  return {
    shouldCompact: isOverBudget(messages, budget) && fold.length > 0,
    foldCount: fold.length,
    keepCount: messages.length - fold.length,
    foldChars: fold.reduce((n, m) => n + m.content.length, 0),
  };
}

/**
 * Build the transcript handed to the summarizer. Pure string transform so it is
 * testable without a model.
 */
export function buildTranscript(fold: ChatMessage[]): string {
  return fold
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

/**
 * Replace the foldable prefix with a single summary message. Pure — the caller
 * supplies the summary text so this stays deterministic and unit-testable.
 */
export function applySummary(
  messages: ChatMessage[],
  summary: string,
  sessionId: string,
): ChatMessage[] {
  const keep = keptMessages(messages);
  if (messages.length <= KEEP_RECENT_TURNS) return messages;
  const summaryMessage: ChatMessage = {
    id: crypto.randomUUID(),
    sessionId,
    role: "user",
    content: `${SUMMARY_PREFIX}\n${summary}`,
    createdAt: new Date().toISOString(),
  };
  return [summaryMessage, ...keep];
}

export const COMPACT_PROMPT = `Summarize the conversation below so another agent can continue the work without re-reading it.

Keep: the user's goal and constraints, decisions made, files touched, commands run and their outcomes, and anything still outstanding.
Drop: pleasantries, redundant restatements, and long verbatim tool output.
Write dense prose or tight bullets. No preamble.`;