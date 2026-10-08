import { describe, expect, test } from "bun:test";
import {
  applySummary,
  buildTranscript,
  estimateMessagesTokens,
  estimateTokens,
  isOverBudget,
  planCompaction,
  KEEP_RECENT_TURNS,
} from "../src/compact.js";
import type { ChatMessage } from "@fable/protocol";

function msg(role: "user" | "assistant", content: string): ChatMessage {
  return { id: crypto.randomUUID(), sessionId: "s", role, content, createdAt: new Date().toISOString() };
}

function history(n: number, size = 100): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(msg(i % 2 === 0 ? "user" : "assistant", `turn ${i} `.padEnd(size, "x")));
  }
  return out;
}

describe("token estimation", () => {
  test("rounds up and never returns zero for content", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  test("adds per-message overhead", () => {
    const one = estimateMessagesTokens([msg("user", "x".repeat(400))]);
    expect(one).toBe(100 + 8);
  });
});

describe("budget checks", () => {
  test("empty history is under budget", () => {
    expect(isOverBudget([], 1000)).toBe(false);
  });

  test("detects overflow", () => {
    expect(isOverBudget(history(40, 1000), 1000)).toBe(true);
  });
});

describe("planCompaction", () => {
  test("does nothing under budget", () => {
    const plan = planCompaction(history(4, 10), 100_000);
    expect(plan.shouldCompact).toBe(false);
    expect(plan.foldCount).toBe(0);
  });

  test("folds all but the recent window when over budget", () => {
    const messages = history(20, 1000);
    const plan = planCompaction(messages, 1000);
    expect(plan.shouldCompact).toBe(true);
    expect(plan.keepCount).toBe(KEEP_RECENT_TURNS);
    expect(plan.foldCount).toBe(20 - KEEP_RECENT_TURNS);
  });

  test("never plans a fold when history is shorter than the keep window", () => {
    const plan = planCompaction(history(3, 100_000), 1);
    expect(plan.shouldCompact).toBe(false);
  });
});

describe("buildTranscript", () => {
  test("labels roles and preserves order", () => {
    const t = buildTranscript([msg("user", "do it"), msg("assistant", "done")]);
    expect(t).toBe("User: do it\n\nAssistant: done");
  });
});

describe("applySummary", () => {
  test("collapses the prefix into one summary message", () => {
    const messages = history(20, 100);
    const out = applySummary(messages, "summary text", "s");
    expect(out.length).toBe(KEEP_RECENT_TURNS + 1);
    expect(out[0]?.content).toContain("summary text");
    expect(out[0]?.content).toContain("compacted earlier conversation");
  });

  test("keeps the most recent turns verbatim", () => {
    const messages = [msg("user", "old"), ...history(20, 100)];
    const out = applySummary(messages, "s", "s");
    expect(out.at(-1)?.content).toBe(messages.at(-1)?.content);
  });

  test("is a no-op when history fits in the window", () => {
    const messages = history(3, 10);
    expect(applySummary(messages, "s", "s")).toBe(messages);
  });

  test("summarizing shrinks the payload", () => {
    const messages = history(20, 2000);
    const out = applySummary(messages, "short", "s");
    expect(estimateMessagesTokens(out)).toBeLessThan(estimateMessagesTokens(messages));
  });
});