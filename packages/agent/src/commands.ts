export interface CommandResult {
  /** Text injected into the conversation as a user turn. */
  prompt?: string;
  /** Shell command to run; output is returned for the model to read. */
  shell?: { command: string; timeoutMs?: number };
  /** Human-readable note printed before execution. */
  note?: string;
}

export interface CommandDef {
  name: string;
  description: string;
  run: (ctx: CommandCtx) => Promise<CommandResult>;
}

export interface CommandCtx {
  cwd: string;
  arg: string;
  model: string;
}

export const COMMANDS: CommandDef[] = [
  {
    name: "verify",
    description: "Run build, typecheck and lint, then report failures",
    run: async () => ({
      note: "running verification…",
      shell: { command: "bun run check-types", timeoutMs: 180000 },
      prompt:
        "Run the full verification suite for this project in order: `bun run build`, `bun run check-types`, `bun run lint`. " +
        "Read each output. If anything fails, diagnose the root cause from the actual error text, fix it with minimal edits, and re-run that step until it passes. Report a short summary at the end.",
    }),
  },
  {
    name: "test",
    description: "Run the project test suite and fix failures",
    run: async () => ({
      note: "running tests…",
      shell: { command: "bun test", timeoutMs: 180000 },
      prompt:
        "Run the project test suite. Read the failure output carefully, identify the root cause of each failure, " +
        "fix it with minimal edits, and re-run until green. Do not weaken or delete assertions to force a pass — fix the cause.",
    }),
  },
  {
    name: "review",
    description: "Review uncommitted changes for bugs",
    run: async () => ({
      prompt:
        "Review the current uncommitted changes (`git diff` and `git diff --staged`). Look for real defects: logic errors, " +
        "unhandled failure paths, race conditions, resource leaks, and security issues. Report only genuine problems, " +
        "ranked by severity, with file:line references. Skip style nits.",
    }),
  },
  {
    name: "commit",
    description: "Stage and commit all changes with a generated message",
    run: async () => ({
      prompt:
        "Create a git commit for all current changes. Inspect `git status` and `git diff`, then write a commit message " +
        "with a concise imperative subject line and a body explaining why. Match the existing commit style in `git log`. " +
        "Never commit secrets, .env files, or credentials.",
    }),
  },
];

export const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.name, c]));

export function commandHelp(): string {
  return COMMANDS.map((c) => `  /${c.name.padEnd(8)} ${c.description}`).join("\n");
}