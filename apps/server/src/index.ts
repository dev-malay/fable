import { type ServerWebSocket, serve } from "bun";
import { createSession, ENGINE, resolveModel, runPrompt, VERSION } from "@fable/agent";
import {parseClientEvent,
  serializeServerEvent,
  type ServerEvent,
  type Session
} from "@fable/protocol";

const PORT = 3101;

const sessions = new Map<string, Session>();

function send(ws: ServerWebSocket<unknown>, event: ServerEvent): void {
  ws.send(serializeServerEvent(event));
}

function getOrCreateSession(sessionId: string | undefined): {
  session: Session;
  created: boolean;
} {
  if (sessionId !== undefined) {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return { session: existing, created: false };
  }
  const session = createSession();
  sessions.set(session.id, session);
  return { session, created: true };
}

async function handleChatSend(
  ws: ServerWebSocket<unknown>,
  prompt: string,
  sessionId: string | undefined,
): Promise<void> {
  const { session, created } = getOrCreateSession(sessionId);
  if (created) send(ws, { type: "session.created", session });
  const messageId = crypto.randomUUID();
  let content = "";
  for await (const delta of runPrompt(prompt, {
    onToolEvent: (event) => {
      if (event.type === "tool.start") {
        send(ws, { type: "tool.start", name: event.name, summary: event.summary });
      } else {
        send(ws, { type: "tool.result", name: event.name, ok: event.ok, preview: event.preview });
      }
    },
  })) {
    content += delta;
    send(ws, { type: "chat.delta", sessionId: session.id, messageId, delta });
  }
  send(ws, { type: "chat.done", sessionId: session.id, messageId, content });
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
          sessions: sessions.size,
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
          const session = createSession(event.title ?? "Untitled session");
          sessions.set(session.id, session);
          send(ws, { type: "session.created", session });
          return;
        }
        await handleChatSend(ws, event.prompt, event.sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        send(ws, { type: "error", message });
      }
    },
  },
});




console.log(`fable server listening on http://localhost:${PORT} (engine=${ENGINE})`);




