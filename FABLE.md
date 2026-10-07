# FABLE.md

Project context for the fable coding agent. This file is injected into the
system prompt, so anything here changes how the agent behaves in this repo.

## Commands
- Install: `bun install`
- Build: `bun run build`
- Typecheck: `bun run check-types`
- Lint: `bun run lint`
- Verify all: `fable /verify`

## Conventions
- TypeScript everywhere, ESM, strict mode
- No default exports; named exports only
- Comments should explain *why*, not *what*
- Run `bun run check-types` before declaring any task done

## Layout
- `apps/cli` — terminal entrypoint
- `apps/server` — local agent host (HTTP + WebSocket)
- `packages/agent` — engine, tools, permissions
- `packages/protocol` — shared types and events

## Notes
- Free models get rate limited; prefer small, fast models for iteration.
- Never commit `.env` or API keys.
