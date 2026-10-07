import { type ServerWebSocket, serve } from "bun";
import {
  buildContext,
  createSession,
  ENGINE,
  resolveModel,
  runPrompt,
  sessionStore,
  VERSION,
} from "@fable/agent";
import {
  parseClientEvent,
  serializeServerEvent,
  type ChatMessage,
  type ServerEvent,
  type Session,
  type ToolEvent,
} from "@fable/protocol";

const PORT = 3101;

interface Live {
  session: Session;
  messages: ChatMessage[];
  tools: ToolEvent[];
}

const live = new Map<string, Live>();

function send(ws: ServerWebSocket<unknown>, event: ServerEvent): void {
  ws.send(serializeServerEvent(event));
}

function toMessage(role: "user" | "assistant", content: string, sessionId: string): ChatMessage {
  return { id: crypto.randomUUID(), sessionId, role, content, createdAt: new Date().toISOString() };
}

async function createLive(title: string): Promise<Live> {
  const session = createSession(title, { cwd: process.cwd() });
  const entry: Live = { session, messages: [], tools: [] };
  live.set(session.id, entry);
  return entry;
}

async function resolveLive(sessionId: string | undefined): Promise<Live> {
  if (sessionId !== undefined) {
    const existing = live.get(sessionId);
    if (existing !== undefined) return existing;
    const loaded = await sessionStore.load(sessionId);
    if (loaded !== null) {
      const entry: Live = { session: loaded.meta, messages: loaded.messages, tools: loaded.tools };
      live.set(entry.session.id, entry);
      return entry;
    }
  }
  return createLive("Untitled session");
}

async function persist(entry: Live): Promise<void> {
  await sessionStore.save(
    {
      ...entry.session,
      cwd: entry.session.cwd ?? process.cwd(),
      model: entry.session.model ?? resolveModel(),
      maxTurns: entry.session.maxTurns ?? 10,
      skipPermissions: entry.session.skipPermissions ?? false,
    },
    entry.messages,
    entry.tools,
  );
}

async function handleChatSend(
  ws: ServerWebSocket<unknown>,
  prompt: string,
  sessionId: string | undefined,
  isNew: boolean,
): Promise<void> {
  const entry = isNew ? await createLive(prompt.slice(0, 60)) : await resolveLive(sessionId);
  if (isNew) send(ws, { type: "session.created", session: entry.session });
  else if (sessionId === undefined) send(ws, { type: "session.created", session: entry.session });

  const priorHistory = [...entry.messages];
  entry.messages.push(toMessage("user", prompt, entry.session.id));

  let content = "";
  let extraContext = "";
  try {
    extraContext = await buildContext(entry.session.cwd ?? process.cwd());
  } catch {
    extraContext = "";
  }

  try {
    for await (const delta of runPrompt(prompt, {
      cwd: entry.session.cwd ?? process.cwd(),
      model: entry.session.model,
      history: priorHistory,
      extraContext,
      permissionMode: "bypass",
      onToolEvent: (event) => {
        entry.tools.push(event);
        send(ws, event);
      },
    })) {
      content += delta;
      send(ws, { type: "chat.delta", sessionId: entry.session.id, messageId: entry.session.id, delta });
    }
    if (content !== "") entry.messages.push(toMessage("assistant", content, entry.session.id));
    await persist(entry);
    send(ws, { type: "chat.done", sessionId: entry.session.id, messageId: entry.session.id, content });
  } catch (error) {
    await persist(entry);
    const message = error instanceof Error ? error.message : "unknown error";
    send(ws, { type: "error", message });
  }
}

serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json(
        {
          ok: true,
          engine: ENGINE,
          model: resolveModel(),
          version: VERSION,
          sessions: live.size,
          time: new Date().toISOString(),
        },
        { headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }
    if (url.pathname === "/v1/stream") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    async message(ws, raw) {
      const event = parseClientEvent(raw);
      if (event === null) {
        send(ws, { type: "error", message: "invalid event (see @fable/protocol)" });
        return;
      }
      try {
        if (event.type === "session.new") {
          const entry = await createLive(event.title ?? "Untitled session");
          await persist(entry);
          send(ws, { type: "session.created", session: entry.session });
          return;
        }
        await handleChatSend(ws, event.prompt, event.sessionId, event.sessionId === undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        send(ws, { type: "error", message });
      }
    },
  },
});

console.log(`fable server listening on http://localhost:${PORT} (engine=${ENGINE})`);