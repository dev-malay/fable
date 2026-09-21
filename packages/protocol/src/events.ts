import type { Session } from "./types.js";

export type ClientEvent =
  | { type: "chat.send"; prompt: string; sessionId?: string }
  | { type: "session.new"; title?: string };

export type ToolEvent =
  | { type: "tool.start"; name: string; summary: string; permission?: "auto" | "asked" | "skipped" }
  | { type: "tool.result"; name: string; ok: boolean; preview: string; permission?: "auto" | "asked" | "skipped" };

export type ServerEvent =
  | { type: "session.created"; session: Session }
  | {
      type: "chat.delta";
      sessionId: string;
      messageId: string;
      delta: string;
    }
  | {
      type: "chat.done";
      sessionId: string;
      messageId: string;
      content: string;
    }
  | { type: "error"; message: string }
  | ToolEvent;

/** Strict-parse an inbound WebSocket frame. Returns null when invalid. */
export function parseClientEvent(raw: unknown): ClientEvent | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const type = (value as { type?: unknown }).type;
  if (type === "chat.send") {
    const prompt = (value as { prompt?: unknown }).prompt;
    const sessionId = (value as { sessionId?: unknown }).sessionId;
    if (typeof prompt !== "string") return null;
    if (sessionId !== undefined && typeof sessionId !== "string") return null;
    return sessionId === undefined
      ? { type: "chat.send", prompt }
      : { type: "chat.send", prompt, sessionId };
  }
  if (type === "session.new") {
    const title = (value as { title?: unknown }).title;
    if (title !== undefined && typeof title !== "string") return null;
    return title === undefined ? { type: "session.new" } : { type: "session.new", title };
  }
  return null;
}

export function serializeServerEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}
