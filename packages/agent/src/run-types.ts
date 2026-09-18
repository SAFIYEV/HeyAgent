import type { AgentSession } from "@heyagent/shared";
import type { ModelRef } from "@heyagent/models";

export interface AgentRunOptions {
  sessionId?: string;
  /** Explicitly selected installed skills; validated before execution. */
  skillNames?: string[];
  channelKey?: string;
  channel?: AgentSession["channel"];
  modelRef?: ModelRef;
  onApprovalNeeded?: (
    description: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<boolean>;
  onStatus?: (
    status: "idle" | "thinking" | "working" | "done" | "error" | "skipped",
    detail?: string,
  ) => void;
  /** Cron/proactive runs — soft hint in prompt */
  proactive?: boolean;
}

export interface AgentRunResult {
  sessionId: string;
  response: string;
  toolCallsExecuted: string[];
}
