import { createInterface } from "node:readline";
import { permissionEngine } from "@riox/agent";

export type Approval = "allow" | "deny" | "always" | "never";

export async function promptPermission(
  tool: string,
  summary: string,
  pattern?: string
): Promise<Approval> {
  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const promptText = pattern
      ? `Allow ${tool} (${pattern}) ${summary}? [y/n/always/never] `
      : `Allow ${tool} ${summary}? [y/n/always/never] `;
    rl.question(promptText, (text: string) => {
      rl.close();
      resolve(text);
    })
  });
  const norm = answer.trim().toLowerCase();
  if (norm === "y" || norm === "yes") return "allow";
  if (norm === "a" || norm === "always") return "always";
  if (norm === "n" || norm === "no" || norm === "never") return "never";
  return "deny";

}

export async function handlePermissionPrompt(
  tool: string,
  summary: string,
  input: Record<string, unknown>
): Promise<"allow" | "deny"> {
  const pattern = tool === "Bash" ? String(input.command ?? "") : undefined;
  const decision = await promptPermission(tool, summary, pattern);
  if (decision === "always" || decision === "never") {
    await permissionEngine.addRule({
      tool,
      pattern,
      decision: decision === "always" ? "allow" : "deny",
    });
    console.log(`\x1b[90mRule saved: ${tool} ${pattern ?? ""} → ${decision === "always" ? "always allow" : "always deny"}\x1b[0m`);
  }

  return decision === "allow" || decision === "always" ? "allow" : "deny"
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}



