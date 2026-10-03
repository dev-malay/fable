import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, ChatMessage, ToolEvent } from "@fable/protocol";


const SESSIONS_DIR = join(homedir(), ".fable", "sessions");

interface PersistedSession {
  meta: Session & {
    cwd: string;
    model: string;
    maxTurns: number;
    skipPermissions: boolean;
    messageCount: number;
    lastTurnAt: string;
  };
  messages: ChatMessage[];
  tools: ToolEvent[];
}

function ensureDir(): Promise<void> {
  return mkdir(SESSIONS_DIR, { recursive: true }).then(() => undefined);
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.jsonl`);
}

export class SessionStore {
  async save(session: Session & {
    cwd: string;
    model: string;
    maxTurns: number;
    skipPermissions: boolean;
  }, messages: ChatMessage[], tools: ToolEvent[]): Promise<void> {
    await ensureDir();
    const path = sessionPath(session.id);
    const meta = {
      ...session,
      messageCount: messages.length,
      lastTurnAt: new Date().toISOString(),
    };
    const lines = [
      JSON.stringify({ type: "meta", data: meta }),
      ...messages.map((m) => JSON.stringify({ type: "message", data: m })),
      ...tools.map((t) => JSON.stringify({ type: "tool", data: t })),
    ];
    await writeFile(path, lines.join("\n") + "\n", "utf8");
  }

  async load(id: string): Promise<PersistedSession | null> {
    const path = sessionPath(id);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      return null;
    }
    const lines = content.trim().split("\n").filter((l: string) => l);
    if (lines.length === 0) return null;
    let meta: PersistedSession["meta"] | null = null;
    const messages: ChatMessage[] = [];
    const tools: ToolEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "meta" && parsed.data) meta = parsed.data;
        else if (parsed.type === "message" && parsed.data) messages.push(parsed.data);
        else if (parsed.type === "tool" && parsed.data) tools.push(parsed.data);
      } catch {
        continue;
      }
    }
    if (!meta) return null;
    return { meta, messages, tools };
  }

  async list(): Promise<Session[]> {
    try {
      await ensureDir();
      const entries = await readdir(SESSIONS_DIR);
      const sessions: Session[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const id = entry.slice(0, -6);
        const loaded = await this.load(id);
        if (loaded) sessions.push(loaded.meta);
      }
      return sessions.sort((a, b) => (b.lastTurnAt ?? b.createdAt).localeCompare(a.lastTurnAt ?? a.createdAt));
    } catch {
      return []
    }
  }

  async delete(id: string): Promise<void> {
    const path = sessionPath(id);
    try {
      await rm(path);
    } catch {
    }
  }

  async fork(id: string, newTitle?: string): Promise<Session> {
    const loaded = await this.load(id);
    if (!loaded) throw new Error(`session ${id} not found`);
    const newSession = {
      ...loaded.meta,
      id: crypto.randomUUID(),
      title: newTitle ?? `${loaded.meta.title} (fork)`,
      createdAt: new Date().toISOString(),
      lastTurnAt: new Date().toISOString()
    };
    await this.save(newSession, loaded.messages, loaded.tools)
    return newSession;
  }
}

export const sessionStore = new SessionStore();