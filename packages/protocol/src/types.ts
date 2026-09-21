export type EngineName = "mock" | "openrouter";

export type Role = "user" | "assistant";

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  skipPermissions?: boolean;
  messageCount?: number;
  lastTurnAt?: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type PermissionDecision = "allow" | "deny" | "ask";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass";

export interface PermissionRule {
  tool: string;
  pattern?: string;
  decision: PermissionDecision;
  source: "default" | "user" | "flag";
}