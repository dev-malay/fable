import { spawn } from "node:child_process";
import { cap, int, str, type ToolContext, type ToolDef } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120000;

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; out: string }> {
  const shell = process.platform === "win32" ? "cmd" : "sh";
  const flag = process.platform === "win32" ? "/c" : "-c";
  return new Promise((resolve, reject) => {
    const child = spawn(shell, [flag, command], { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const combined = stderr === "" ? stdout : `${stdout}\nSTDERR:\n${stderr}`;
      resolve({ code, out: combined });
    });
  });
}

export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  if (command.trim() === "") return Promise.reject(new Error("empty command"));
  return runShell(command, cwd, timeoutMs).then(({ code, out }) => `exit=${code}\n${out}`);
}

export const bashTool: ToolDef = {
  name: "Bash",
  description: "Run a shell command in the working directory and return its output.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run" },
      timeoutMs: { type: "integer", description: "Kill after this many ms (default 120000)" },
    },

    required: ["command"],
    additionalProperties: false,
  },
  needsApproval: true,
  summarize: (input) => (str(input, "command") ?? "").slice(0, 80),
  execute: async (input, ctx: ToolContext) => {
    const command = str(input, "command") ?? "";
    if (command.trim() === "") throw new Error("empty command");
    const timeoutMs = int(input, "timeoutMs", DEFAULT_TIMEOUT_MS);
    const { code, out } = await runShell(command, ctx.cwd, timeoutMs);
    return cap(`exit=${code}\n${out}`);
  },
  
};
