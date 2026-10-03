import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionRule {
  tool: string;
  pattern?: string;
  decision: PermissionDecision;
  source: "default" | "user" | "flag";
}

const PERMISSIONS_DIR = join(homedir(), ".fable");
const PERMISSIONS_FILE = join(PERMISSIONS_DIR, "permissions.json");

interface StoredPermissions {
  rules: PermissionRule[];
}

const DEFAULT_RULES: PermissionRule[] = [
  { tool: "Read", decision: "allow", source: "default" },
  { tool: "Glob", decision: "allow", source: "default" },
  { tool: "Grep", decision: "allow", source: "default" },
  { tool: "WebFetch", decision: "allow", source: "default" },
  { tool: "TodoWrite", decision: "allow", source: "default" },
  { tool: "Bash", pattern: "ls*", decision: "allow", source: "default" },
  { tool: "Bash", pattern: "cat*", decision: "allow", source: "default" },
  { tool: "Bash", pattern: "git status", decision: "allow", source: "default" },
  { tool: "Bash", pattern: "git diff*", decision: "allow", source: "default" },
  { tool: "Bash", pattern: "git log*", decision: "allow", source: "default" },
  { tool: "Bash", pattern: "pwd", decision: "allow", source: "default" },
  { tool: "Bash", pattern: "which*", decision: "allow", source: "default" },
  { tool: "Bash", pattern: "echo*", decision: "allow", source: "default" },
  { tool: "Bash", pattern: "mkdir*", decision: "allow", source: "default" },
  { tool: "Bash", pattern: "rm*", decision: "deny", source: "default" },
  { tool: "Bash", pattern: "mv*", decision: "deny", source: "default" },
  { tool: "Bash", pattern: "chmod*", decision: "deny", source: "default" },
  { tool: "Bash", pattern: "chown*", decision: "deny", source: "default" },
  { tool: "Bash", pattern: "sudo*", decision: "deny", source: "default" },
  { tool: "Bash", pattern: "curl*|sh", decision: "deny", source: "default" },
  { tool: "Bash", pattern: "wget*|sh", decision: "deny", source: "default" },
  { tool: "Write", decision: "ask", source: "default" },
  { tool: "Edit", decision: "ask", source: "default" },
  { tool: "Bash", decision: "ask", source: "default" },
];

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass";

function modeOverrides(mode: PermissionMode): PermissionRule[] {
  switch (mode) {
    case "acceptEdits":
      return [
        { tool: "Write", decision: "allow", source: "flag" },
        { tool: "Edit", decision: "allow", source: "flag" },
      ];
    case "plan":
      return [
        { tool: "Write", decision: "deny", source: "flag" },
        { tool: "Edit", decision: "deny", source: "flag" },
        { tool: "Bash", decision: "deny", source: "flag" },
      ];
    case "bypass":
      return [{ tool: "*", decision: "allow", source: "flag" }];
    default:
      return [];
  }
}

function ensureDir(): Promise<void> {
  return mkdir(PERMISSIONS_DIR, { recursive: true }).then(() => undefined);
}

function readStored(): Promise<StoredPermissions> {
  return ensureDir()
    .then(() => readFile(PERMISSIONS_FILE, "utf8"))
    .then((content) => JSON.parse(content) as StoredPermissions)
    .catch(() => ({ rules: [] }));
}

function writeStored(data: StoredPermissions): Promise<void> {
  return ensureDir().then(() => writeFile(PERMISSIONS_FILE, JSON.stringify(data, null, 2), "utf8"));
}

function matchesRule(rule: PermissionRule, tool: string, input: Record<string, unknown>): boolean {
  if (rule.tool !== "*" && rule.tool !== tool) return false;
  if (!rule.pattern) return true;
  if (tool === "Bash") {
    const command = String(input.command ?? "");
    return minimatch(command, rule.pattern, { nocomment: true });
  }
  return true;
}

function mergeRules(...layers: PermissionRule[][]): PermissionRule[] {
  const seen = new Set<string>();
  const result: PermissionRule[] = [];
  for (const layer of layers) {
    for (const rule of layer) {
      const key = `${rule.source}:${rule.tool}:${rule.pattern ?? ""}:${rule.decision}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(rule);
      }
    }
  }
  return result;
}

export class PermissionEngine {
  private mode: PermissionMode;
  private userRules: PermissionRule[] = [];
  private flagRules: PermissionRule[] = [];

  constructor(mode: PermissionMode = "default") {
    this.mode = mode;
    this.flagRules = modeOverrides(mode);
  }

  async load(): Promise<void> {
    const stored = await readStored();
    this.userRules = stored.rules ?? [];
  }

  async addRule(rule: Omit<PermissionRule, "source">): Promise<void> {
    const fullRule: PermissionRule = { ...rule, source: "user" };
    this.userRules = this.userRules.filter(
      (r) => !(r.tool === fullRule.tool && r.pattern === fullRule.pattern && r.decision === fullRule.decision)
    );
    this.userRules.push(fullRule);
    await writeStored({ rules: this.userRules });
  }

  async removeRule(tool: string, pattern?: string, decision?: PermissionDecision): Promise<void> {
    this.userRules = this.userRules.filter(
      (r) => !(r.tool === tool && r.pattern === pattern && (!decision || r.decision === decision))
    );
    await writeStored({ rules: this.userRules });
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.flagRules = modeOverrides(mode);
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  getAllRules(): PermissionRule[] {
    return mergeRules(this.flagRules, this.userRules, DEFAULT_RULES);
  }

  evaluate(tool: string, input: Record<string, unknown>): PermissionDecision {
    const rules = this.getAllRules();
    for (const rule of rules) {
      if (matchesRule(rule, tool, input)) {
        return rule.decision;
      }
    }
    return "ask";
  }

  getRulesForDisplay(): PermissionRule[] {
    return this.getAllRules().filter((r) => r.source !== "default");
  }
}

export const permissionEngine = new PermissionEngine();