import {
  loadConfig,
  preserveUserMessage,
  resolveLocale,
  type AgentSession,
} from "@heyagent/shared";
import { loadIdentity, buildSystemPrompt, buildWorkspacePromptBlock, appendDailyNote } from "@heyagent/identity";
import {
  chatCompletion,
  resolveDefaultModel,
  resolveFastModel,
  parseModelFallbacks,
  FallbackSummaryError,
  type ModelRef,
  type ChatMessage,
  type ToolDefinition,
} from "@heyagent/models";
import { enqueueByKey, sessionQueueKey } from "./session-queue.js";
import { ToolLoopGuard } from "./tool-loop.js";
import { maybeCompactSession, buildCompactionPromptBlock } from "./compaction.js";
import { PolicyEngine } from "@heyagent/policy";
import { loadSession, createSession, addMessage, getRecentMessages } from "./session.js";
import { createToolRegistry, type AgentTool } from "./tools.js";
import { registerComputerTools } from "./tools-computer.js";
import { registerIntegrationTools } from "./tools-integrations.js";
import { registerMemoryTools } from "./tools-memory.js";
import { registerPowerTools } from "./tools-power.js";
import { registerCronTools } from "./tools-cron.js";
import { registerScreenTools } from "./tools-screen.js";
import { buildSkillsPromptBlock } from "./skills-loader.js";
import {
  loadMemory,
  buildMemoryPromptBlock,
  rememberAction,
  cancelMission,
  getOrCreateChannelSession,
} from "./memory.js";
import {
  VISION_MARKER,
  findLatestVisionJpeg,
  captureScreenVision,
  formatVisionToolResult,
  uiTree,
} from "@heyagent/computer";
import { readFile } from "node:fs/promises";
import {
  globalOrchestrator,
  setWorldStateProvider,
  telegramWorldHint,
  buildToolSelection,
  applyToolSelection,
  getCurrentStep,
  beginStep,
  completeStep,
  patchScratch,
  formatScratchBlock,
  inferStepFromTool,
  withToolResultRetry,
  indexNote,
  ActionLedger,
  DuplicateWriteActionError,
  loadActionLedger,
  persistActionLedger,
  type ActionRecord,
  type Mission,
  type PlanStep,
  type RouteDecision,
} from "@heyagent/orchestrator";
import { matchHarness } from "./harness/match.js";
import { executeHarness } from "./harness/execute.js";

let worldProviderReady = false;
let actionLedgerPromise: Promise<ActionLedger> | undefined;

function durableActionLedger(): Promise<ActionLedger> {
  actionLedgerPromise ??= loadActionLedger().catch(() => new ActionLedger());
  return actionLedgerPromise;
}
async function ensureWorldProvider(): Promise<void> {
  if (worldProviderReady) return;
  worldProviderReady = true;
  setWorldStateProvider(async () => {
    const computer = await import("@heyagent/computer");
    const chat = computer.getLastOpenedTelegramChat?.() ?? null;
    return telegramWorldHint(chat);
  });
}

export type { AgentRunOptions, AgentRunResult } from "./run-types.js";
import type { AgentRunOptions, AgentRunResult } from "./run-types.js";

export function guardRunOptions(options: AgentRunOptions): AgentRunOptions {
  return {
    ...options,
    onStatus: options.onStatus
      ? (status, detail) => {
          try {
            options.onStatus?.(status, detail);
          } catch (error) {
            console.warn(
              "Agent onStatus callback failed:",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      : undefined,
  };
}

function toOpenAITools(tools: AgentTool[]): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name.replace(/\./g, "_"),
    description: t.description,
    parameters: t.parameters?.type
      ? t.parameters
      : {
          type: "object",
          properties: t.parameters?.properties ?? {},
          additionalProperties: true,
        },
  }));
}

function fromApiToolName(name: string): string {
  return name.replace(/_/g, ".");
}

function toApiToolName(name: string): string {
  return name.replace(/\./g, "_");
}

/** True when tool summaries contain verifiable success, not bare ERROR. */
function hasToolEvidence(summaries: string[]): boolean {
  return summaries.some(
    (s) =>
      /\b(OK|DONE|SUCCESS|created|saved|opened|path:|https?:\/\/|wrote|installed)\b/i.test(s) &&
      !/^(ERROR|FAIL|WARNING|BLOCKED)\b/i.test(s.trim()),
  );
}

function sessionMessagesToChat(session: AgentSession): ChatMessage[] {
  // Persist only user/assistant turns; tool loops stay in-memory for the current run.
  return getRecentMessages(session)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
}

export class AgentRuntime {
  private registry = createToolRegistry();
  private policy: PolicyEngine;

  constructor() {
    this.policy = new PolicyEngine("ask");
    registerComputerTools(this.registry);
    registerPowerTools(this.registry);
    registerScreenTools(this.registry);
    registerIntegrationTools(this.registry);
    registerMemoryTools(this.registry);
    registerCronTools(this.registry);
  }

  async init(): Promise<void> {
    const config = await loadConfig();
    // Policy levels: ask | risky (ask-on-risky) | allowlist | full
    // Default "risky" = autonomous except irreversible actions.
    this.policy = new PolicyEngine(config.policy?.mode ?? "risky", config.policy?.allowlist ?? []);
  }

  getTools(): AgentTool[] {
    return this.registry.list();
  }

  getPolicy(): PolicyEngine {
    return this.policy;
  }

  async run(userMessage: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const guardedOptions = guardRunOptions(options);
    const qKey = sessionQueueKey({
      sessionId: guardedOptions.sessionId,
      channelKey: guardedOptions.channelKey,
      channel: guardedOptions.channel,
    });
    return enqueueByKey(qKey, () => this.runUnlocked(userMessage, guardedOptions));
  }

  private async runUnlocked(
    userMessage: string,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    await this.init();

    const explicitSkillsBlock = options.skillNames?.length
      ? await buildSkillsPromptBlock(userMessage, options.skillNames)
      : undefined;

    const config = await loadConfig();
    const locale = resolveLocale(config);
    const identity = await loadIdentity();
    if (!identity) {
      throw new Error(
        locale === "ru"
          ? "Агент не настроен. Запустите: hey onboard"
          : "Agent not onboarded. Run: hey onboard",
      );
    }

    const modelRef = options.modelRef ?? resolveDefaultModel(config.models ?? {});
    const modelFallbacks = parseModelFallbacks(config.models?.fallbacks);
    const fastRef = resolveFastModel(config.models ?? {});
    const llmOpts = {
      fallbacks: modelFallbacks,
      onFallback: (from: ModelRef, to: ModelRef, reason: string) => {
        options.onStatus?.(
          "thinking",
          `failover:${from.provider}/${from.model}→${to.provider}/${to.model}(${reason})`,
        );
      },
    };

    let session: AgentSession;
    if (options.sessionId) {
      const existing = await loadSession(options.sessionId);
      if (!existing) {
        throw new Error(
          locale === "ru"
            ? `Сессия не найдена: ${options.sessionId}`
            : `Session not found: ${options.sessionId}`,
        );
      }
      session = existing;
    } else if (options.channelKey) {
      const id = await getOrCreateChannelSession(options.channelKey, async () => {
        const s = await createSession(options.channel ?? "telegram");
        return s.id;
      });
      const existing = await loadSession(id);
      session = existing ?? (await createSession(options.channel ?? "telegram"));
    } else {
      session = await createSession(options.channel ?? "cli");
    }

    const originalUserMessage = preserveUserMessage(userMessage);
    session.currentTask = originalUserMessage.trim().slice(0, 240);
    await maybeCompactSession(session, {
      modelRef: fastRef,
      useLlm: config.features?.compaction !== false,
    }).catch(() => undefined);

    // Act on the owner's exact text. The old LLM "reread" pass could invent
    // corrections and leaked its internal rewrite notes into the conversation.
    // Locale is presentation-only. Routing and execution always receive the
    // exact user input, including casing, punctuation and whitespace.
    const workingMessage = originalUserMessage;
    const rereadPrefix = "";

    const clockEnabled = config.features?.accurateClock !== false;
    if (clockEnabled) {
      const { detectTimeIntent, formatClockForHumans, getClockSnapshot } =
        await import("@heyagent/computer");
      if (detectTimeIntent(userMessage) || detectTimeIntent(workingMessage)) {
        await addMessage(session, { role: "user", content: userMessage });
        const response = formatClockForHumans(getClockSnapshot(config.timezone));
        await addMessage(session, { role: "assistant", content: response });
        options.onStatus?.("done");
        return {
          sessionId: session.id,
          response,
          toolCallsExecuted: ["clock.now"],
        };
      }
    }

    await ensureWorldProvider();
    const orch = await globalOrchestrator.orchestrate(
      { goal: userMessage, clarifiedGoal: workingMessage },
      (p) => {
        const status =
          p.status === "waiting"
            ? "working"
            : p.status === "error"
              ? "done"
              : p.status === "idle"
                ? "idle"
                : p.status;
        options.onStatus?.(status, p.detail);
      },
    );
    const orchMemoryBlock = orch.memoryBlock;
    options.onStatus?.(
      "thinking",
      `orchestrator:${orch.route.domain}/${orch.dispatch.harness}`,
    );

    // Single harness registry — deterministic paths (cancel may fall through)
    const harness = matchHarness({
      userMessage,
      workingMessage,
      orch,
      clockEnabled: false, // clock already handled above
    });
    options.onStatus?.("thinking", `harness:${harness.id}`);
    const harnessResult = explicitSkillsBlock && harness.id !== "cancel" ? null : await executeHarness(harness, {
      userMessage,
      workingMessage,
      rereadPrefix,
      session,
      identity,
      modelRef,
      orch,
      options,
      locale,
      timezone: config.timezone,
    });
    if (harnessResult) return harnessResult;

    // A soft/failed harness falls through into the LLM loop. Claim the UI
    // lane here as well; otherwise browser/desktop routes can run concurrently
    // merely because they do not have a dedicated deterministic harness.
    if (orch.mission.requiresUi) {
      const queuedMission = globalOrchestrator.getQueue().get(orch.mission.id);
      const claimed =
        queuedMission?.status === "running" ||
        Boolean(globalOrchestrator.getQueue().tryClaim(orch.mission.id));
      if (!claimed) {
        const response = "Сейчас уже идёт другая UI-миссия. Подожди или скажи «стоп», потом повтори.";
        await addMessage(session, { role: "user", content: userMessage });
        await addMessage(session, { role: "assistant", content: response });
        options.onStatus?.("done");
        return { sessionId: session.id, response, toolCallsExecuted: ["orchestrator.queue"] };
      }
    }

    let effectiveUserMessage = workingMessage.trim() || userMessage.trim();
    if (options.proactive) {
      effectiveUserMessage = /^\[SYSTEM HEARTBEAT\]/i.test(effectiveUserMessage)
        ? [
            "[PROACTIVE HEARTBEAT CONTROL TURN]",
            "The checklist below is policy, not a task. Never execute examples merely because they appear in it.",
            "Act only on independently verified, currently due state. If none is explicitly found, reply exactly HEARTBEAT_OK.",
            "Do not create or open reports/files and do not send messages from checklist wording.",
            effectiveUserMessage,
          ].join("\n")
        : `[PROACTIVE/CRON] ${effectiveUserMessage}\nExecute the scheduled task. Report briefly.`;
    }
    const memBefore = await loadMemory();

    // Stop mission on explicit cancel
    if (/^(стоп|отмена|cancel|хватит|останови|stop)(?:\s|$|[!.,;:])/i.test(effectiveUserMessage)) {
      const { browserHardStop, resetTelegramChatState } = await import("@heyagent/computer");
      await browserHardStop().catch(() => undefined);
      resetTelegramChatState();
      if (memBefore.activeMission?.status === "active") {
        await cancelMission();
      }
      effectiveUserMessage = `${effectiveUserMessage}\n\n[System: owner cancelled. Stop previous browser/chat mission and follow the NEW instruction only.]`;
    }
    // Note: chat-until conversations are handled earlier by the deterministic
    // runTelegramConversation harness, which returns before reaching this point.

    await addMessage(session, { role: "user", content: userMessage });

    const memory = await loadMemory();
    const skillsBlock = explicitSkillsBlock ?? await buildSkillsPromptBlock(effectiveUserMessage);
    const workspaceBlock = await buildWorkspacePromptBlock(identity, locale);
    let liveMission: Mission = structuredClone(orch.mission);
    liveMission = beginStep(liveMission);
    globalOrchestrator.advanceMission(liveMission);

    const toolSel = buildToolSelection(
      orch.route,
      liveMission.plan,
      getCurrentStep(liveMission.plan),
    );
    const scratchBlock = formatScratchBlock(liveMission);
    const clockBlock =
      config.features?.accurateClock === false
        ? ""
        : await (async () => {
            const { formatClockForHumans, getClockSnapshot } = await import("@heyagent/computer");
            return [
              "### ACCURATE TIME (OS clock — never invent)",
              formatClockForHumans(getClockSnapshot(config.timezone)),
              "Time/date → clock_now. Never guess from training data.",
            ].join("\n");
          })();
    // Lean runtime prompt: SOUL/AGENTS/skills carry playbooks; keep only hard gates here.
    const systemPrompt = [
      buildSystemPrompt(identity, locale),
      "",
      workspaceBlock,
      "",
      buildCompactionPromptBlock(session),
      "",
      "### RUNTIME CONTRACT (beats SOUL if conflict)",
      "- Full computer access: screen, shell, files, browser, apps, office, web — use what the task needs.",
      "- PLAN → EXECUTE (tools) → VERIFY → recover ≤3× → escalate with named blocker.",
      "- NEVER invent tool results, paths, URLs, or UI state. ERROR/WARNING = failed step.",
      "- DONE only with evidence from THIS turn's tools, or say blocked (CAPTCHA/login/payment).",
      "- web.search alone is never completion — follow with fetch/open/analyze/browser as needed.",
      "- Ads first in search — skip. YouTube «открой …» = first matching organic (quick).",
      "- Quiz on open tab: tabs.list→focus; answer then Next; never Telegram for tests.",
      "- Notepad: genre exact (рассказ ≠ стишок). Prefer notepad_write over notepad_type.",
      "- Telegram: only when a person/contact is named. Mail words → gmail_*. Do not spam Telegram.",
      "- You SEE via screen_see. Always call tools — never only promise or claim «Done. Ran: …» without proof.",
      "- Russian owner → answer Russian AFTER acting. Short and factual.",
      "",
      clockBlock,
      toolSel.planBlock,
      toolSel.guidance,
      scratchBlock,
      "",
      buildMemoryPromptBlock(memory),
      orchMemoryBlock,
      "",
      skillsBlock,
    ]
      .filter(Boolean)
      .join("\n");

    const tools = applyToolSelection(this.registry.list(), toolSel);
    const apiTools = toOpenAITools(tools);
    const apiNameToTool = new Map(tools.map((t) => [toApiToolName(t.name), t]));
    const forbiddenSet = new Set(toolSel.forbidden);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...sessionMessagesToChat(session).slice(0, -1), // history without the just-added raw user msg
      { role: "user", content: effectiveUserMessage },
    ];

    options.onStatus?.("thinking");
    const toolCallsExecuted: string[] = [];
    const actionSummaries: string[] = [];
    let response = "";
    let iterations = 0;
    const maxIterations =
      memory.activeMission?.status === "active"
        ? (config.agent?.missionMaxIterations ?? 80)
        : (config.agent?.maxIterations ?? 32);
    const loopGuard = new ToolLoopGuard(config.agent?.toolLoopLimit ?? 8);
    let failoverNotice = "";

    while (iterations < maxIterations) {
      iterations++;
      // Ensure every assistant.tool_calls has matching tool messages before API call.
      const safeMessages = repairToolCallMessages(messages);
      messages.length = 0;
      messages.push(...safeMessages);
      let result;
      try {
        result = await chatCompletion(modelRef, messages, {
          tools: apiTools,
          toolChoice: "auto",
          ...llmOpts,
          onFallback: (from, to, reason) => {
          failoverNotice = `↪️ Model fallback: ${to.provider}/${to.model} (was ${from.provider}/${from.model}; ${reason})`;
            llmOpts.onFallback?.(from, to, reason);
          },
        });
      } catch (error) {
        response = formatModelFailure(error);
        await globalOrchestrator.getTimeline().push({
          kind: "error",
          name: "model_failover_exhausted",
          detail: response.slice(0, 500),
          missionId: liveMission.id,
        });
        options.onStatus?.("done", "models_unavailable");
        break;
      }

      if (result.toolCalls?.length) {
        const pendingVisionResults: { toolName: string; toolResult: string }[] = [];
        messages.push({
          role: "assistant",
          content: result.content || "",
          toolCalls: result.toolCalls,
        });

        for (const tc of result.toolCalls) {
          const tool =
            apiNameToTool.get(tc.name) ??
            this.registry.get(fromApiToolName(tc.name)) ??
            this.registry.get(tc.name);

          if (!tool) {
            messages.push({
              role: "tool",
              toolCallId: tc.id,
              content: `Unknown tool: ${tc.name}`,
            });
            continue;
          }

          if (forbiddenSet.has(tool.name)) {
            messages.push({
              role: "tool",
              toolCallId: tc.id,
              content: `BLOCKED: tool «${tool.name}» is hard-blocked for this mission (channel mismatch). Pick another tool — full computer access otherwise.`,
            });
            continue;
          }

          const args = { ...tc.arguments };
          if (tool.name === "browser.open" && typeof args.url === "string") {
            args.url = normalizeUrl(args.url);
          }

          const loopMsg = loopGuard.check(tool.name, args);
          if (loopMsg?.startsWith("LOOP_BREAK")) {
            messages.push({
              role: "tool",
              toolCallId: tc.id,
              content: loopMsg,
            });
            response = `Stopped: tool loop on «${tool.name}». Change approach or report the blocker.`;
            break;
          }

          if (this.policy.requiresApproval(tool.name, args)) {
            const planPreview = [
              "Safe preview",
              `Tool: ${tool.name}`,
              `Why: ${tool.description?.slice(0, 160) || "risky action"}`,
              `Args: ${JSON.stringify(args).slice(0, 280)}`,
            ].join("\n");
            const approved = options.onApprovalNeeded
              ? await options.onApprovalNeeded(planPreview, tool.name, args)
              : false;
            if (!approved) {
              messages.push({
                role: "tool",
                toolCallId: tc.id,
                content: "User denied this action.",
              });
              continue;
            }
          }

          if (loopMsg?.startsWith("LOOP_WARN")) {
            // Soft warn: still execute, but inject note after
            options.onStatus?.("working", `${tool.name}:loop_warn`);
          }

          options.onStatus?.("working", tool.name);
          await this.policy.auditLog({
            tool: tool.name,
            args,
            sessionId: session.id,
          });

          const relatedBeforeExecution = inferStepFromTool(liveMission.plan, tool.name);
          const durableWrite = isDurableWriteTool(tool.name);
          let actionRecord: ActionRecord | undefined;
          if (durableWrite) {
            try {
              const ledger = await durableActionLedger();
              actionRecord = ledger.begin({
                missionId: liveMission.id,
                stepId: relatedBeforeExecution?.id ?? `tool:${tc.id}`,
                actionType: tool.name,
                input: args,
                idempotencyKey: relatedBeforeExecution
                  ? `${liveMission.id}:${relatedBeforeExecution.id}:${tool.name}`
                  : undefined,
              });
              await persistActionLedger(ledger);
            } catch (error) {
              if (error instanceof DuplicateWriteActionError) {
                messages.push({
                  role: "tool",
                  toolCallId: tc.id,
                  content: `BLOCKED: duplicate write action; previous success ${error.previous.id}`,
                });
                await globalOrchestrator.getTimeline().push({
                  kind: "error",
                  name: "duplicate_write_blocked",
                  detail: `${tool.name} -> ${error.previous.id}`,
                  missionId: liveMission.id,
                });
                continue;
              }
              throw error;
            }
          }

          try {
            const rawToolResult: unknown = await withToolResultRetry(
              async (attempt) => {
                if (attempt > 1) {
                  await globalOrchestrator.getTimeline().push({
                    kind: "tool",
                    name: tool.name,
                    detail: `retry ${attempt}`,
                    missionId: liveMission.id,
                  });
                }
                return tool.execute(args);
              },
              { times: durableWrite ? 1 : 2, baseMs: 450 },
            );
            const toolResult = normalizeToolResult(rawToolResult);
            toolCallsExecuted.push(tool.name);
            actionSummaries.push(`${tool.name}: ${toolResult.slice(0, 300)}`);
            await rememberAction(tool.name, toolResult.slice(0, 500));

            // Persist step state between tools (don't lose the plan)
            const related = inferStepFromTool(liveMission.plan, tool.name);
            const ok = await verifyConcreteToolOutcome(tool.name, args, toolResult);
            if (actionRecord) {
              const ledger = await durableActionLedger();
              const completed = ledger.complete(actionRecord.id, ok ? "succeeded" : "failed", [{
                id: `tool_${tc.id}`,
                kind: "tool_result",
                summary: toolResult.slice(0, 500),
                capturedAt: new Date().toISOString(),
              }]);
              await persistActionLedger(ledger);
              liveMission = {
                ...liveMission,
                actionHistory: [...(liveMission.actionHistory ?? []), completed],
              };
            }
            liveMission = patchScratch(liveMission, {
              lastTool: tool.name,
              lastResult: toolResult.slice(0, 400),
              lastOk: ok,
              iteration: iterations,
            });
            if (related && ok) {
              const verified = await verifyToolStep(liveMission, related, orch.route, toolResult);
              if (verified) {
                liveMission = completeStep(liveMission, "done", toolResult.slice(0, 200), related.id);
                liveMission = beginStep(liveMission);
              } else if (related.verify) {
                liveMission = patchScratch(liveMission, {
                  lastVerification: `pending: ${related.verify}`,
                });
              }
            } else if (related && !ok) {
              liveMission = patchScratch(liveMission, {
                lastError: `${tool.name}: ${toolResult.slice(0, 200)}`,
              });
            }
            globalOrchestrator.advanceMission(liveMission);
            await indexNote(
              `${orch.route.domain} | ${tool.name} | ${ok ? "ok" : "fail"} | ${toolResult.slice(0, 160)}`,
              "tool",
            ).catch(() => undefined);

            const toolPayload = stripVisionPayload(toolResult);
            messages.push({
              role: "tool",
              toolCallId: tc.id,
              content: loopMsg?.startsWith("LOOP_WARN")
                ? `${loopMsg}\n\n${toolPayload}`
                : toolPayload,
            });
            // Defer vision until ALL tool_call_ids have tool responses (API requirement).
            pendingVisionResults.push({ toolName: tool.name, toolResult });
          } catch (err) {
            if (actionRecord) {
              const ledger = await durableActionLedger();
              const uncertain = ledger.complete(actionRecord.id, "uncertain");
              await persistActionLedger(ledger).catch(() => undefined);
              liveMission = {
                ...liveMission,
                actionHistory: [...(liveMission.actionHistory ?? []), uncertain],
              };
              globalOrchestrator.advanceMission(liveMission);
            }
            messages.push({
              role: "tool",
              toolCallId: tc.id,
              content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }

        if (response.startsWith("Stopped: tool loop")) break;

        // Attach screen verification only after every tool_call_id has a tool message.
        for (const pending of pendingVisionResults) {
          await attachVisionFromToolResult(messages, pending.toolResult);
          await attachUiVerification(messages, pending.toolName);
        }
        options.onStatus?.("thinking");
        continue;
      }

      const content = (result.content ?? "").trim();
      const toolMatch = content.match(/\{[\s\S]*"tool"\s*:\s*"([^"]+)"[\s\S]*\}/);
      if (toolMatch) {
        try {
          const parsed = JSON.parse(toolMatch[0]) as {
            tool: string;
            args: Record<string, unknown>;
          };
          const tool = this.registry.get(parsed.tool);
          if (tool) {
            const args = { ...parsed.args };
            if (tool.name === "browser.open" && typeof args.url === "string") {
              args.url = normalizeUrl(String(args.url));
            }
            const planPreview = [
              "Safe preview",
              `Tool: ${tool.name}`,
              `Args: ${JSON.stringify(args).slice(0, 280)}`,
            ].join("\n");
            if (
              !this.policy.requiresApproval(tool.name, args) ||
              (options.onApprovalNeeded &&
                (await options.onApprovalNeeded(planPreview, tool.name, args)))
            ) {
              options.onStatus?.("working", tool.name);
              const toolResult = normalizeToolResult(await tool.execute(args));
              toolCallsExecuted.push(tool.name);
              actionSummaries.push(`${tool.name}: ${toolResult.slice(0, 300)}`);
              await rememberAction(tool.name, toolResult.slice(0, 500));
              messages.push({ role: "assistant", content });
              messages.push({
                role: "user",
                content: `Tool result for ${tool.name}:\n${stripVisionPayload(toolResult)}\nContinue.`,
              });
              await attachVisionFromToolResult(messages, toolResult);
              await attachUiVerification(messages, tool.name);
              continue;
            }
          }
        } catch {
          /* fall through */
        }
      }

      response =
        content ||
        (toolCallsExecuted.length && hasToolEvidence(actionSummaries)
          ? `Completed tools: ${toolCallsExecuted.join(", ")}. Summarize with evidence for the owner.`
          : "");
      if (!response && toolCallsExecuted.length && iterations < maxIterations) {
        messages.push({
          role: "user",
          content:
            "No verified completion yet. Continue with tools (screen, browser, shell, files…) until the task is done with evidence, or report a named blocker.",
        });
        options.onStatus?.("thinking");
        continue;
      }
      if (response) break;
      if (!toolCallsExecuted.length) break;
    }

    if (!response && toolCallsExecuted.length) {
      if (hasToolEvidence(actionSummaries)) {
        response = `Completed tools: ${toolCallsExecuted.join(", ")}. Check tool output above for evidence.`;
      } else {
        response = `Incomplete: ran ${toolCallsExecuted.join(", ")} but no verified result. Say what blocked you or retry with different tools.`;
      }
    }
    if (!response && iterations >= maxIterations) {
      response = `Stopped: hit max_iterations=${maxIterations}. Partial tools: ${toolCallsExecuted.join(", ") || "none"}.`;
    }

    if (failoverNotice) {
      response = `${failoverNotice}\n\n${response}`.trim();
    }

    // Persist action trail so the next turn remembers what happened
    if (actionSummaries.length) {
      await addMessage(session, {
        role: "assistant",
        content: `[actions]\n${actionSummaries.map((s) => `- ${s}`).join("\n")}`,
      });
    }
    await addMessage(session, { role: "assistant", content: response });

    // Close out mission plan state — do NOT fake-complete pending steps
    liveMission = patchScratch(liveMission, {
      finishedAt: new Date().toISOString(),
      toolsRan: toolCallsExecuted.slice(-12),
    });
    const stillPending = liveMission.plan.steps.some(
      (s) => s.status === "pending" || s.status === "running",
    );
    if (stillPending) {
      for (const s of liveMission.plan.steps) {
        if (s.status === "pending" || s.status === "running") {
          liveMission = completeStep(
            liveMission,
            "failed",
            "loop ended before step verified",
            s.id,
          );
        }
      }
      liveMission = { ...liveMission, status: "failed" };
    } else {
      liveMission = { ...liveMission, status: "done" };
    }
    globalOrchestrator.advanceMission(liveMission);
    await globalOrchestrator.noteEpisode(
      effectiveUserMessage.slice(0, 200),
      orch.route.domain,
      toolCallsExecuted.join(",") || "llm_loop",
      stillPending || /ERROR|Stopped|LOOP_BREAK/i.test(response) ? "fail" : "success",
      stillPending
        ? "LLM loop ended with unverified plan steps"
        : "Plan steps completed via tool loop + scratch memory",
    );
    await appendDailyNote(
      `${orch.route.domain}: ${toolCallsExecuted.slice(0, 6).join(",") || "chat"} → ${stillPending ? "partial" : "ok"}`,
    ).catch(() => undefined);

    options.onStatus?.("done");

    const out = rereadPrefix ? `${rereadPrefix}\n\n${response}` : response;
    return {
      sessionId: session.id,
      response: out,
      toolCallsExecuted,
    };
  }
}

function isDurableWriteTool(toolName: string): boolean {
  return /(?:^|\.)(?:send|write|delete|move|edit|install|uninstall|shutdown|restart|publish|submit|confirm|pay|message|file)$/i.test(
    toolName,
  );
}

function normalizeToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  const kind = value === null ? "null" : typeof value;
  return `ERROR: tool returned an invalid ${kind} result`;
}

export async function verifyConcreteToolOutcome(
  toolName: string,
  args: Record<string, unknown>,
  result: string,
): Promise<boolean> {
  if (/^(ERROR|FAIL|BLOCKED|WARNING)\b/i.test(result.trim())) return false;
  if (toolName === "file.write") {
    if (typeof args.path !== "string" || !args.path.trim()) return false;
    try {
      const actual = await readFile(args.path, "utf8");
      return typeof args.content !== "string" || actual === args.content;
    } catch {
      return false;
    }
  }
  if (toolName === "google.docs.write") {
    return /https:\/\/docs\.google\.com\/document\/d\/[^/\s]+\/edit/i.test(result);
  }
  return true;
}

function formatModelFailure(error: unknown): string {
  if (error instanceof FallbackSummaryError) {
    const reasons = error.attempts
      .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.message}`)
      .join("\n");
    return [
      "ERROR: ни одна настроенная модель не смогла продолжить задачу.",
      reasons,
      "Проверь доступ командой `hey models test` или выбери рабочую модель через `/switchmodel`.",
    ].join("\n");
  }
  return `ERROR: model request failed: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * A plan step with `verify` can only be completed after a verifier records
 * evidence on the mission timeline. This prevents a successful-looking tool
 * string from becoming a false "done" state.
 */
async function verifyToolStep(
  mission: Mission,
  step: PlanStep,
  route: RouteDecision,
  evidence: string,
): Promise<boolean> {
  if (!step.verify) return true;
  if (step.verify === "browser_url_ok") {
    const url = evidence.match(/https?:\/\/[^\s)\]"']+/i)?.[0] ?? "";
    const expectedUrlTopic = route.slots.ytQuery || route.slots.query || route.slots.tabQuery;
    const verdict = await globalOrchestrator.verifyStep(mission.id, "browser_url_ok", {
      world: url ? { at: new Date().toISOString(), browser: { url } } : undefined,
      expectedUrlTopic,
      evidence,
    });
    return verdict.verdict === "pass";
  }
  const name = step.verify === "system_ok" ? "system_ok" : "tool_ok";
  const verdict = await globalOrchestrator.verifyStep(mission.id, name, { evidence });
  return verdict.verdict === "pass";
}

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return "https://www.youtube.com";
  if (/^https?:\/\//i.test(t)) return t;
  const lower = t.toLowerCase();
  if (lower === "youtube" || lower === "yt") return "https://www.youtube.com";
  if (lower.includes(".") || lower.includes("/")) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

export { detectMailIntent } from "./harness/intents.js";

function stripVisionPayload(toolResult: string): string {
  // Keep paths/markers for logs but never huge blobs if present
  return toolResult.replace(/base64[,:][A-Za-z0-9+/=\s]{200,}/gi, "[base64 omitted]");
}

/**
 * OpenAI/compatible APIs require: assistant(tool_calls) → tool(tool_call_id)×N
 * with no other roles in between. Vision/user inserts after partial tool replies
 * used to break this and cause HTTP 400.
 */
function repairToolCallMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      out.push(msg);
      const needed = new Set(msg.toolCalls.map((tc) => tc.id));
      const found = new Set<string>();
      i++;
      // Collect immediate tool responses (skip illegal inserts until tools are done)
      const deferred: ChatMessage[] = [];
      while (i < messages.length && found.size < needed.size) {
        const next = messages[i]!;
        if (next.role === "tool" && next.toolCallId && needed.has(next.toolCallId)) {
          if (!found.has(next.toolCallId)) {
            out.push(next);
            found.add(next.toolCallId);
          }
          i++;
          continue;
        }
        if (next.role === "tool") {
          // orphan tool — drop
          i++;
          continue;
        }
        // user/assistant/system in the middle — defer until all tool ids answered
        deferred.push(next);
        i++;
      }
      for (const id of needed) {
        if (!found.has(id)) {
          out.push({
            role: "tool",
            toolCallId: id,
            content: "ERROR: tool result missing (repaired empty response).",
          });
        }
      }
      out.push(...deferred);
      continue;
    }
    if (msg.role === "tool") {
      // Orphan tool without preceding assistant tool_calls — drop
      i++;
      continue;
    }
    out.push(msg);
    i++;
  }
  return out;
}

async function attachVisionFromToolResult(
  messages: ChatMessage[],
  toolResult: string,
): Promise<void> {
  if (!toolResult.includes(VISION_MARKER) && !toolResult.includes("VISION_PATH=")) return;
  const pathMatch =
    toolResult.match(/VISION_PATH=(.+)$/m) ??
    toolResult.match(new RegExp(`${VISION_MARKER}\\s*(.+)$`, "m"));
  if (!pathMatch) return;
  let imgPath = pathMatch[1].trim().split(/\s+/)[0];
  if (imgPath.toLowerCase().endsWith(".png")) {
    imgPath = await findLatestVisionJpeg(imgPath);
  }
  try {
    const buf = await readFile(imgPath);
    const mime =
      imgPath.toLowerCase().endsWith(".jpg") || imgPath.toLowerCase().endsWith(".jpeg")
        ? "image/jpeg"
        : "image/png";
    messages.push({
      role: "user",
      content:
        "SCREEN IMAGE ATTACHED below. LOOK at it. Identify visible UI (labels, buttons, inputs) and estimate pixel coordinates (origin top-left, FULL primary screen). Then act: computer_click / computer_type / computer_hotkey / ui_find. Do not ask the user what is on screen — you can see it.",
      images: [{ mimeType: mime, data: buf.toString("base64"), detail: "high" }],
    });
  } catch {
    /* ignore missing file */
  }
}

const UI_MUTATING_TOOLS = new Set([
  "app.open",
  "browser.open",
  "telegram.message",
  "telegram.file",
  "computer.click",
  "computer.double_click",
  "computer.type",
  "computer.hotkey",
  "computer.scroll",
  "computer.drag",
]);

async function attachUiVerification(
  messages: ChatMessage[],
  toolName: string,
): Promise<void> {
  if (!UI_MUTATING_TOOLS.has(toolName)) return;
  await new Promise((resolve) =>
    setTimeout(resolve, toolName === "app.open" || toolName === "browser.open" ? 1200 : 450),
  );
  try {
    const shot = await captureScreenVision(1280);
    const result = formatVisionToolResult(
      shot,
      `Automatic verification after ${toolName}. Inspect the screen: did the intended action succeed? If not, recover and try another method.`,
    );
    await attachVisionFromToolResult(messages, result);
  } catch (err) {
    const tree = await uiTree(80).catch(() => "");
    messages.push({
      role: "user",
      content: [
        `Automatic screenshot verification failed after ${toolName}: ${err instanceof Error ? err.message : String(err)}.`,
        "Do not give up. Use this UI Automation tree to verify/recover:",
        tree || "(UI tree unavailable; try screen_see again or use direct API/shell instead.)",
      ].join("\n"),
    });
  }
}

export * from "./session.js";
export * from "./tools.js";
export * from "./memory.js";
export * from "./cron.js";
export * from "./skills-loader.js";
export * from "./harness/background.js";
export * from "./harness/telegram.js";
export * from "./harness/open-tab.js";
export * from "./harness/vision-desk.js";
export { cleanupLine } from "./cleanup.js";
export * from "./compaction.js";
export * from "./predict-dispatch.js";
export { runEvalPack, runScenario, formatEvalReport } from "./eval/runner.js";
export { listScenarios, BUILTIN_SCENARIOS } from "./eval/scenarios.js";
export type { EvalReport, EvalScenario, ScenarioResult } from "./eval/types.js";
export { matchHarness } from "./harness/match.js";
export { harnessMetricsReport } from "./harness/metrics.js";
export { detectCronScheduleIntent } from "./harness/cron-intent.js";
export * from "./waiting-owner.js";
export * from "./mission-history.js";
export {
  tryHandleChatCommand,
  TELEGRAM_BOT_COMMANDS,
  type ChatCommandResult,
} from "./chat-commands.js";
export * from "./voice-settings.js";
