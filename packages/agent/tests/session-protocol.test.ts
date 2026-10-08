import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClientEvent, serializeServerEvent } from "../../protocol/src/events.js";
import { SessionStore } from "../src/session.js";
import type { ChatMessage, ToolEvent } from "@fable/protocol";

describe("parseClientEvent", () => {
  test("rejects non-string frames", () => {
    expect(parseClientEvent({ type: "chat.send" })).toBeNull();
    expect(parseClientEvent(42)).toBeNull();
  });

  test("rejects malformed json", () => {
    expect(parseClientEvent("{not json")).toBeNull();
  });

  test("rejects unknown event types", () => {
    expect(parseClientEvent(JSON.stringify({ type: "hack" }))).toBeNull();
  });

  test("parses chat.send", () => {
    const e = parseClientEvent(JSON.stringify({ type: "chat.send", prompt: "hi" }));
    expect(e).toEqual({ type: "chat.send", prompt: "hi" });
  });

  test("parses chat.send with a sessionId", () => {
    const e = parseClientEvent(JSON.stringify({ type: "chat.send", prompt: "hi", sessionId: "s1" }));
    expect(e).toEqual({ type: "chat.send", prompt: "hi", sessionId: "s1" });
  });

  test("requires prompt to be a string", () => {
    expect(parseClientEvent(JSON.stringify({ type: "chat.send", prompt: 5 }))).toBeNull();
  });

  test("rejects a non-string sessionId", () => {
    expect(parseClientEvent(JSON.stringify({ type: "chat.send", prompt: "x", sessionId: 9 }))).toBeNull();
  });

  test("parses session.new with and without a title", () => {
    expect(parseClientEvent(JSON.stringify({ type: "session.new" }))).toEqual({ type: "session.new" });
    expect(parseClientEvent(JSON.stringify({ type: "session.new", title: "t" }))).toEqual({
      type: "session.new",
      title: "t",
    });
  });
});

describe("serializeServerEvent", () => {
  test("round-trips through JSON", () => {
    const event = { type: "error", message: "boom" } as const;
    expect(JSON.parse(serializeServerEvent(event))).toEqual(event);
  });
});

function message(role: "user" | "assistant", content: string): ChatMessage {
  return { id: crypto.randomUUID(), sessionId: "s", role, content, createdAt: new Date().toISOString() };
}

describe("SessionStore", () => {
  async function store(): Promise<SessionStore> {
    // unique ids per test keep parallel sandboxes from colliding
    return new SessionStore();
  }

  test("saves and loads a session", async () => {
    const s = await store();
    const id = crypto.randomUUID();
    const messages = [message("user", "hello"), message("assistant", "hi")];
    const tools: ToolEvent[] = [{ type: "tool.start", name: "Read", summary: "a.ts" }];
    await s.save(
      { id, title: "t", createdAt: new Date().toISOString(), cwd: ".", model: "m", maxTurns: 10, skipPermissions: false },
      messages,
      tools,
    );
    const loaded = await s.load(id);
    expect(loaded?.meta.title).toBe("t");
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.tools).toHaveLength(1);
    expect(loaded?.meta.messageCount).toBe(2);
    expect(loaded?.meta.lastTurnAt).toBeDefined();
  });

  test("returns null for an unknown id", async () => {
    const s = await store();
    expect(await s.load("does-not-exist")).toBeNull();
  });

  test("fork copies messages under a new id", async () => {
    const s = await store();
    const id = crypto.randomUUID();
    await s.save(
      { id, title: "orig", createdAt: new Date().toISOString(), cwd: ".", model: "m", maxTurns: 10, skipPermissions: false },
      [message("user", "keep me")],
      [],
    );
    const forked = await s.fork(id);
    expect(forked.id).not.toBe(id);
    expect(forked.title).toContain("fork");
    const loaded = await s.load(forked.id);
    expect(loaded?.messages[0]?.content).toBe("keep me");
  });

  test("fork rejects an unknown id", async () => {
    const s = await store();
    expect(s.fork("nope")).rejects.toThrow(/not found/);
  });

  test("delete removes the file", async () => {
    const s = await store();
    const id = crypto.randomUUID();
    await s.save(
      { id, title: "t", createdAt: new Date().toISOString(), cwd: ".", model: "m", maxTurns: 10, skipPermissions: false },
      [],
      [],
    );
    await s.delete(id);
    expect(await s.load(id)).toBeNull();
  });

  test("list survives a corrupt file", async () => {
    const s = await store();
    const dir = join(tmpdir(), ".fable", "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${crypto.randomUUID()}.jsonl`), "not json at all");
    expect(Array.isArray(await s.list())).toBe(true);
  });
});