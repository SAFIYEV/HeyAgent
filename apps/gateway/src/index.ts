import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  GATEWAY_DEFAULT_HOST,
  GATEWAY_DEFAULT_PORT,
  generateId,
  loadConfig,
  PRODUCT_NAME,
  resolveLocale,
  saveConfig,
  type SupportedLocale,
} from "@heyagent/shared";
import { createIdentity, ensureWorkspace, loadIdentity } from "@heyagent/identity";
import {
  AgentRuntime,
  cronDueJobs,
  cronMarkRan,
  cronList,
  listMissionHistory,
  tryHandleChatCommand,
} from "@heyagent/agent";
import { TelegramChannel } from "@heyagent/channels-telegram";
import { ensureHeyAgentHome } from "@heyagent/integrations";
import { globalMissionQueue, persistMissionQueue } from "@heyagent/orchestrator";
import { PROVIDERS, resolveApiKeyForProvider, smokeTest } from "@heyagent/models";
import { adminStatusReport, isElevatedAdmin, relaunchElevated } from "@heyagent/computer";
import { platform } from "node:os";

const agent = new AgentRuntime();

interface PendingApproval {
  id: string;
  description: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: string;
  resolve: (ok: boolean) => void;
}

const pendingApprovals = new Map<string, PendingApproval>();
const wsClients = new Set<WebSocket>();

function broadcastWs(payload: unknown): void {
  const raw = JSON.stringify(payload);
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) ws.send(raw);
  }
}

async function requestApproval(
  description: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  const id = generateId("appr");
  const plan = {
    type: "approval_needed" as const,
    id,
    description,
    toolName,
    args,
    preview: [
      "📋 Safe preview — подтверди действие:",
      description,
      `Инструмент: ${toolName}`,
      `Аргументы: ${JSON.stringify(args).slice(0, 400)}`,
    ].join("\n"),
  };
  broadcastWs(plan);
  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(id, {
      id,
      description,
      toolName,
      args,
      createdAt: new Date().toISOString(),
      resolve: (ok) => {
        pendingApprovals.delete(id);
        resolve(ok);
      },
    });
    setTimeout(() => {
      const p = pendingApprovals.get(id);
      if (p) {
        pendingApprovals.delete(id);
        p.resolve(false);
        broadcastWs({ type: "approval_resolved", id, approved: false, reason: "timeout" });
      }
    }, 120_000);
  });
}

function resolveApproval(id: string, approved: boolean): boolean {
  const p = pendingApprovals.get(id);
  if (!p) return false;
  p.resolve(approved);
  broadcastWs({ type: "approval_resolved", id, approved });
  return true;
}

/**
 * Elevated launch (Windows UAC) is OPT-IN so a fresh clone doesn't hit a scary
 * prompt on first run. Enable with features.requireAdmin=true (or HEYAGENT_ADMIN=1)
 * when you actually need admin-only actions.
 */
export function shouldRequestAdmin(
  requireAdmin: boolean | undefined,
  env: { HEYAGENT_ADMIN?: string; HEYAGENT_NO_ADMIN?: string },
  os: NodeJS.Platform,
): boolean {
  if (os !== "win32") return false;
  if (env.HEYAGENT_NO_ADMIN) return false;
  return requireAdmin === true || env.HEYAGENT_ADMIN === "1";
}

export async function startGateway(): Promise<void> {
  await ensureHeyAgentHome();
  const config = await loadConfig();

  const wantAdmin = shouldRequestAdmin(config.features?.requireAdmin, process.env, platform());
  if (wantAdmin) {
    const elevated = await isElevatedAdmin();
    if (!elevated) {
      if (process.argv.includes("--elevated")) {
        console.warn(
          "UAC не выдал администратора — продолжаю как обычный пользователь. Для полного доступа запусти снова и подтверди UAC.",
        );
      } else {
        console.log("Запрашиваю полные права администратора (UAC)…");
        try {
          const started = await relaunchElevated(["--elevated"]);
          if (started) {
            console.log("Elevated gateway запущен в новом окне. Это окно можно закрыть.");
            process.exit(0);
          }
        } catch (err) {
          console.warn(
            "Не удалось авто-elevate:",
            err instanceof Error ? err.message : err,
            "— работаю без админа.",
          );
        }
      }
    }
  }

  // Real browser profile (owner logins + session tabs) is DEFAULT.
  // Guest temp profile ONLY when features.browserRealProfile === false or HEYAGENT_BROWSER_GUEST=1.
  const wantGuest =
    process.env.HEYAGENT_BROWSER_GUEST === "1" ||
    config.features?.browserRealProfile === false;
  if (wantGuest) {
    process.env.HEYAGENT_BROWSER_REAL_PROFILE = "0";
    process.env.HEYAGENT_BROWSER_GUEST = "1";
  } else {
    process.env.HEYAGENT_BROWSER_REAL_PROFILE = "1";
    delete process.env.HEYAGENT_BROWSER_GUEST;
  }

  console.log(await adminStatusReport());
  console.log(
    `Browser profile: ${
      wantGuest
        ? "GUEST (temp) — явно выключен real profile"
        : "REAL (твой аккаунт + вкладки; при attach перезапустит браузер с CDP)"
    }`,
  );

  const host = config.gateway?.host ?? GATEWAY_DEFAULT_HOST;
  const port = config.gateway?.port ?? GATEWAY_DEFAULT_PORT;

  const server = createServer(async (req, res) => {
    await handleHttp(req, res);
  });

  const onListenError = (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // Not an error: the gateway is already up. Exit 0 so scripts/CLI don't
      // treat "already running" as a failure.
      console.log(
        [
          `Gateway уже запущен на ${host}:${port} — это нормально, ничего делать не нужно.`,
          "  • Просто пиши боту в Telegram.",
          "  • Перезапуск: npx hey gateway restart",
          "  • Стоп:     npx hey gateway stop",
        ].join("\n"),
      );
      process.exit(0);
    }
    console.error("Gateway listen error:", err);
    process.exit(1);
  };

  server.on("error", onListenError);

  const wss = new WebSocketServer({ server });
  // ws re-emits server errors — must handle or Node throws Unhandled 'error' event
  wss.on("error", onListenError);
  wss.on("connection", (ws) => handleWs(ws));

  server.listen(port, host, () => {
    console.log(`${PRODUCT_NAME} Gateway listening on http://${host}:${port}`);
  });

  const telegram = await TelegramChannel.fromConfig();
  if (telegram) {
    telegram.start().catch((err) => {
      console.error("Telegram channel died:", err);
    });
  } else {
    console.log("Telegram: disabled or no botToken in config");
  }

  // Restore + run background mission worker (chat-until waits for hours)
  try {
    const { restoreMissionQueue } = await import("@heyagent/orchestrator");
    const { startBackgroundWorker, setBackgroundNotify } = await import("@heyagent/agent");
    await restoreMissionQueue();
    if (telegram) {
      setBackgroundNotify(async (channelKey, text) => {
        const m = channelKey.match(/^telegram:(\d+)/);
        if (m) await telegram.notifyChat(Number(m[1]), text);
      });
    }
    startBackgroundWorker(20_000);
    console.log("Background mission worker started (20s tick)");
  } catch (err) {
    console.warn(
      "Background worker not started:",
      err instanceof Error ? err.message : err,
    );
  }

  // OpenClaw-style cron ticker
  setInterval(() => {
    void tickCron();
  }, 30_000);

  // Heartbeat (separate from cron): periodic proactive turn guided by HEARTBEAT.md
  let lastHeartbeatAt = 0;
  setInterval(() => {
    void tickHeartbeat(config, () => lastHeartbeatAt, (t) => {
      lastHeartbeatAt = t;
    });
  }, 60_000);
}

async function tickCron(): Promise<void> {
  try {
    const due = await cronDueJobs();
    for (const job of due) {
      const channelKey = `cron:${job.id}`;
      console.log(`[cron] running ${job.name} (${job.id})`);
      try {
        const result = await agent.run(
          `[SYSTEM CRON] Наступило время для задачи «${job.name}»: ${job.prompt}`,
          {
            channel: "cli",
            channelKey,
            proactive: true,
          },
        );
        await cronMarkRan(job.id, result.response);
        console.log(`[cron] done ${job.name}`);
      } catch (err) {
        await cronMarkRan(job.id, err instanceof Error ? err.message : String(err));
        console.error(`[cron] failed ${job.name}:`, err);
      }
    }
  } catch (err) {
    console.error("[cron] tick error:", err);
  }
}

async function tickHeartbeat(
  config: Awaited<ReturnType<typeof loadConfig>>,
  getLast: () => number,
  setLast: (t: number) => void,
): Promise<void> {
  try {
    if (config.features?.heartbeat === false) return;
    const everyMin = Math.max(5, Number(config.heartbeat?.everyMinutes ?? 30) || 30);
    const everyMs = everyMin * 60_000;
    const now = Date.now();
    if (now - getLast() < everyMs) return;
    setLast(now);

    // Cron and the mission worker own actionable background work. A heartbeat
    // is deliberately side-effect free: sending a policy checklist through
    // the normal agent router can turn example words into real actions.
    const { readHeartbeatChecklist } = await import("@heyagent/identity");
    await readHeartbeatChecklist();
    console.log(`[heartbeat] ok (every ${everyMin}m)`);
  } catch (err) {
    console.error("[heartbeat] tick error:", err);
  }
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    json(res, 200, { ok: true, product: PRODUCT_NAME });
    return;
  }

  if (url.pathname === "/identity" && req.method === "GET") {
    const identity = await loadIdentity();
    json(res, 200, { identity });
    return;
  }

  // The desktop shell used to pretend that onboarding was complete and only
  // showed a terminal command. Keep this endpoint deliberately small: it
  // stores identity and presentation preferences, never credentials.
  if (url.pathname === "/onboard" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        name?: string;
        avatarId?: string;
        persona?: string;
        locale?: SupportedLocale;
      };
      const locale: SupportedLocale = body.locale === "en" ? "en" : "ru";
      const identity = await createIdentity(
        String(body.name ?? ""),
        String(body.avatarId ?? ""),
        String(body.persona ?? "friendly"),
        locale,
      );
      await ensureWorkspace(locale);
      const config = await loadConfig();
      config.user = { ...config.user, locale };
      await saveConfig(config);
      json(res, 201, { ok: true, identity });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (url.pathname === "/status" && req.method === "GET") {
    const config = await loadConfig();
    const identity = await loadIdentity();
    const missions = globalMissionQueue.list();
    const active = globalMissionQueue.activeUi();
    json(res, 200, {
      ok: true,
      product: PRODUCT_NAME,
      locale: resolveLocale(config),
      identity: identity ? { name: identity.name, avatarId: identity.avatarId } : null,
      model: `${config.models?.defaultProvider}/${config.models?.defaultModel}`,
      missions: {
        total: missions.length,
        activeUi: active?.id ?? null,
        byStatus: missions.reduce<Record<string, number>>((acc, m) => {
          acc[m.status] = (acc[m.status] || 0) + 1;
          return acc;
        }, {}),
      },
      pendingApprovals: pendingApprovals.size,
      telegramReplyMode: config.telegram?.replyMode ?? "text",
      cliReplyMode: config.cli?.replyMode ?? "text",
    });
    return;
  }

  if (url.pathname === "/models" && req.method === "GET") {
    const config = await loadConfig();
    const providers = await Promise.all(
      PROVIDERS.filter((p) => p.id !== "elevenlabs").map(async (p) => ({
        id: p.id,
        name: p.name,
        hasKey: Boolean(await resolveApiKeyForProvider(p.id)),
      })),
    );
    json(res, 200, {
      default: `${config.models?.defaultProvider}/${config.models?.defaultModel}`,
      fallbacks: config.models?.fallbacks ?? [],
      providers,
    });
    return;
  }

  if (url.pathname === "/models/test" && req.method === "POST") {
    const config = await loadConfig();
    const provider = config.models?.defaultProvider;
    const model = config.models?.defaultModel;
    if (!provider || !model) {
      json(res, 400, { ok: false, message: "Сначала выберите и подключите модель." });
      return;
    }
    try {
      json(res, 200, await smokeTest({ provider, model }));
    } catch (err) {
      json(res, 200, { ok: false, message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (url.pathname === "/preflight" && req.method === "GET") {
    const config = await loadConfig();
    const identity = await loadIdentity();
    const provider = config.models?.defaultProvider;
    const model = config.models?.defaultModel;
    const hasModelKey = provider ? Boolean(await resolveApiKeyForProvider(provider)) : false;
    json(res, 200, {
      ready: Boolean(identity && provider && model && hasModelKey),
      checks: [
        { id: "identity", ok: Boolean(identity), label: "Профиль агента", detail: identity?.name || "Не настроен" },
        { id: "model", ok: Boolean(provider && model), label: "Модель", detail: provider && model ? `${provider}/${model}` : "Не выбрана" },
        { id: "credentials", ok: hasModelKey, label: "Доступ к модели", detail: hasModelKey ? "Ключ найден локально" : "Подключите ключ в терминале" },
        { id: "browser", ok: true, label: "Браузер", detail: config.features?.browserRealProfile === false ? "Гостевой профиль" : "Ваш профиль (по умолчанию)" },
      ],
    });
    return;
  }

  if (url.pathname === "/missions" && req.method === "GET") {
    const history = await listMissionHistory(15);
    json(res, 200, {
      queue: globalMissionQueue.list().map((m) => ({
        id: m.id,
        goal: m.goal,
        status: m.status,
        requiresUi: m.requiresUi,
        updatedAt: m.updatedAt,
        harness: m.plan?.steps?.[0]?.kind,
        steps: m.plan?.steps?.map((step) => ({ kind: step.kind, status: step.status })) ?? [],
      })),
      activeUi: globalMissionQueue.activeUi()?.id ?? null,
      history,
      cron: await cronList(),
    });
    return;
  }

  if (url.pathname === "/missions/cancel" && req.method === "POST") {
    const body = await readBody(req);
    const { id } = (body ? JSON.parse(body) : {}) as { id?: string };
    const cancelled = globalMissionQueue.cancel(id);
    await persistMissionQueue();
    json(res, 200, { cancelled: cancelled.map((m) => m.id) });
    return;
  }

  if (url.pathname === "/missions/pause" && req.method === "POST") {
    const body = await readBody(req);
    const { id } = (body ? JSON.parse(body) : {}) as { id?: string };
    const paused = globalMissionQueue.pause(id);
    await persistMissionQueue();
    json(res, 200, { paused: paused.map((m) => m.id) });
    return;
  }

  if (url.pathname === "/approvals" && req.method === "GET") {
    json(res, 200, {
      pending: [...pendingApprovals.values()].map((p) => ({
        id: p.id,
        description: p.description,
        toolName: p.toolName,
        args: p.args,
        createdAt: p.createdAt,
      })),
    });
    return;
  }

  if (url.pathname.startsWith("/approvals/") && req.method === "POST") {
    const id = url.pathname.slice("/approvals/".length);
    const body = await readBody(req);
    const { approve } = JSON.parse(body || "{}") as { approve?: boolean };
    const ok = resolveApproval(id, approve !== false);
    json(res, ok ? 200 : 404, { ok, id, approved: approve !== false });
    return;
  }

  if (url.pathname === "/chat" && req.method === "POST") {
    const body = await readBody(req);
    const { message, sessionId } = JSON.parse(body) as {
      message: string;
      sessionId?: string;
    };
    try {
      const cmd = await tryHandleChatCommand(message, {
        channel: "desktop",
        channelKey: `desktop:${sessionId || "main"}`,
      });
      if (cmd.handled && cmd.reply) {
        json(res, 200, {
          sessionId: sessionId ?? "desktop",
          response: cmd.reply,
          toolCallsExecuted: ["chat.command"],
        });
        return;
      }
      const result = await agent.run(message, {
        sessionId,
        channel: "desktop",
        onApprovalNeeded: requestApproval,
      });
      json(res, 200, result);
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (url.pathname === "/tools" && req.method === "GET") {
    json(res, 200, {
      tools: agent.getTools().map((t: { name: string; description: string }) => ({
        name: t.name,
        description: t.description,
      })),
    });
    return;
  }

  json(res, 404, { error: "Not found" });
}

function handleWs(ws: WebSocket): void {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: "connected", product: PRODUCT_NAME }));

  ws.on("close", () => wsClients.delete(ws));
  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString()) as {
        type: string;
        message?: string;
        sessionId?: string;
        id?: string;
        approve?: boolean;
      };

      if (msg.type === "approval" && msg.id) {
        resolveApproval(msg.id, msg.approve !== false);
        return;
      }

      if (msg.type === "chat" && msg.message) {
        const cmd = await tryHandleChatCommand(msg.message, {
          channel: "desktop",
          channelKey: `desktop:${msg.sessionId || "main"}`,
        });
        if (cmd.handled && cmd.reply) {
          ws.send(
            JSON.stringify({
              type: "response",
              sessionId: msg.sessionId ?? "desktop",
              response: cmd.reply,
              toolCallsExecuted: ["chat.command"],
            }),
          );
          return;
        }
        ws.send(JSON.stringify({ type: "status", status: "thinking" }));
        const result = await agent.run(msg.message, {
          sessionId: msg.sessionId,
          channel: "desktop",
          onStatus: (status: string, detail?: string) =>
            ws.send(JSON.stringify({ type: "status", status, detail })),
          onApprovalNeeded: requestApproval,
        });
        ws.send(JSON.stringify({ type: "response", ...result }));
      }
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGateway().catch(console.error);
}
