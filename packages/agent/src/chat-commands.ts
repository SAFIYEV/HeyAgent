/**
 * In-chat slash commands — work from Telegram / CLI / desktop without leaving the session.
 */
import { loadConfig, saveConfig } from "@heyagent/shared";
import {
  AVATAR_CATALOG,
  isValidAvatarId,
  loadIdentity,
  saveIdentity,
  validateAgentName,
  type AvatarId,
} from "@heyagent/identity";
import {
  PROVIDERS,
  formatModelRef,
  resolveModelRef,
  resolveApiKeyForProvider,
  listModelIds,
  type ModelRef,
} from "@heyagent/models";

export interface ChatCommandResult {
  handled: boolean;
  reply?: string;
  /** CLI may reload identity / session model after these. */
  effects?: {
    identityChanged?: boolean;
    modelChanged?: ModelRef;
    /** Switch the session's coding workspace folder. */
    workspaceChanged?: string;
  };
}

const CMD =
  /^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/;

function parseSlash(text: string): { cmd: string; args: string } | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const m = t.match(CMD);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), args: (m[2] || "").trim() };
}

function helpText(): string {
  return [
    "Команды прямо в чате:",
    "",
    "/status — модель, аватар, голос",
    "/switchmodel [provider/model] — сменить модель (без аргумента — список)",
    "/switchavatar [N|sprite-XX] — сменить аватар",
    "/switchname <имя> — переименовать агента",
    "/cwd <папка> — рабочая папка проекта для задач кодирования",
    "/voice — меню голоса (1 вкл/выкл, 2 API key, 3 voice id)",
    "/help — эта справка",
    "",
    "Алиасы: /model /avatar /name /avatars",
  ].join("\n");
}

async function statusText(): Promise<string> {
  const config = await loadConfig();
  const identity = await loadIdentity();
  const model = `${config.models?.defaultProvider ?? "?"}/${config.models?.defaultModel ?? "?"}`;
  const av = identity
    ? `${identity.name} · ${identity.avatarId}`
    : "не onboard (hey onboard)";
  const { voiceStatusText } = await import("./voice-settings.js");
  return [
    "📊 Статус",
    `Агент: ${av}`,
    `Модель: ${model}`,
    "",
    await voiceStatusText(),
    "",
    "Смена: /switchmodel  /switchavatar  /voice",
  ].join("\n");
}

async function listModelsText(): Promise<string> {
  const config = await loadConfig();
  const current = `${config.models?.defaultProvider}/${config.models?.defaultModel}`;
  const lines: string[] = [
    `Текущая модель: ${current}`,
    "",
    "Провайдеры (есть ключ ✓):",
  ];
  for (const p of PROVIDERS) {
    if (p.id === "elevenlabs") continue;
    const has = Boolean(await resolveApiKeyForProvider(p.id));
    const ids = listModelIds(p).slice(0, 4).join(", ");
    lines.push(`${has ? "✓" : "·"} ${p.id}: ${ids}${listModelIds(p).length > 4 ? "…" : ""}`);
  }
  lines.push("", "Алиасы: /switchmodel fable5 | opus5 | opus4.8 | sonnet5 | haiku45 | gpt5.6");
  lines.push("Или полный ID: /switchmodel bedrock/us.anthropic.claude-fable-5");
  return lines.join("\n");
}

async function switchModel(args: string): Promise<ChatCommandResult> {
  if (!args) {
    return { handled: true, reply: await listModelsText() };
  }
  if (/^(list|ls|status)$/i.test(args)) {
    return { handled: true, reply: await listModelsText() };
  }
  try {
    const parsed = resolveModelRef(args);
    if (!getKnownProvider(parsed.provider)) {
      return {
        handled: true,
        reply: `Неизвестный провайдер «${parsed.provider}».\n${await listModelsText()}`,
      };
    }
    const config = await loadConfig();
    config.models = {
      ...config.models,
      defaultProvider: parsed.provider,
      defaultModel: parsed.model,
      // A model switch is explicit: start with this one model, never carry
      // over a fallback chain created for a previous selection.
      fallbacks: [],
    };
    await saveConfig(config);
    return {
      handled: true,
      reply: [
        `✅ Модель: ${formatModelRef(parsed)}`,
        "Дальше ответы идут на ней (без выхода из чата).",
        parsed.provider === "bedrock"
          ? "Если 403/AccessDenied — прими оферту в AWS Marketplace: hey models marketplace"
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      effects: { modelChanged: parsed },
    };
  } catch (err) {
    return {
      handled: true,
      reply: `Не разобрал модель: ${err instanceof Error ? err.message : String(err)}\nФормат: /switchmodel fable5  или  bedrock/us.anthropic.claude-fable-5`,
    };
  }
}

function getKnownProvider(id: string): boolean {
  return PROVIDERS.some((p) => p.id === id);
}

function listAvatarsText(current?: string): string {
  const lines = ["Аватары:", ""];
  AVATAR_CATALOG.forEach((a, i) => {
    const mark = a.id === current ? " ← сейчас" : "";
    lines.push(`${String(i + 1).padStart(2)}. ${a.id} — ${a.label}${mark}`);
  });
  lines.push("", "Пример: /switchavatar 4  или  /switchavatar sprite-04");
  return lines.join("\n");
}

function resolveAvatarArg(args: string): AvatarId | null {
  const t = args.trim();
  if (!t) return null;
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    const hit = AVATAR_CATALOG[n - 1];
    return hit ? (hit.id as AvatarId) : null;
  }
  const id = t.toLowerCase().startsWith("sprite-") ? t.toLowerCase() : `sprite-${t.padStart(2, "0")}`;
  return isValidAvatarId(id) ? id : null;
}

async function switchAvatar(args: string): Promise<ChatCommandResult> {
  const identity = await loadIdentity();
  if (!args || /^(list|ls)$/i.test(args)) {
    return { handled: true, reply: listAvatarsText(identity?.avatarId) };
  }
  const avatarId = resolveAvatarArg(args);
  if (!avatarId) {
    return {
      handled: true,
      reply: `Не нашёл аватар «${args}».\n${listAvatarsText(identity?.avatarId)}`,
    };
  }
  if (!identity) {
    return {
      handled: true,
      reply: "Сначала onboard: hey onboard — потом /switchavatar.",
    };
  }
  identity.avatarId = avatarId;
  await saveIdentity(identity);
  const label = AVATAR_CATALOG.find((a) => a.id === avatarId)?.label ?? avatarId;
  return {
    handled: true,
    reply: `✅ Аватар: ${avatarId} (${label})`,
    effects: { identityChanged: true },
  };
}

async function switchName(args: string): Promise<ChatCommandResult> {
  if (!args) {
    const identity = await loadIdentity();
    return {
      handled: true,
      reply: identity
        ? `Имя сейчас: ${identity.name}\nСмена: /switchname НовоеИмя`
        : "Агент ещё не создан (hey onboard).",
    };
  }
  const err = validateAgentName(args);
  if (err) return { handled: true, reply: `Имя не принято: ${err}` };
  const identity = await loadIdentity();
  if (!identity) {
    return { handled: true, reply: "Сначала hey onboard." };
  }
  identity.name = args.trim();
  await saveIdentity(identity);
  return {
    handled: true,
    reply: `✅ Имя агента: ${identity.name}`,
    effects: { identityChanged: true },
  };
}

/**
 * If `text` is a known slash command (or pending /voice reply), handle it.
 * Otherwise `{ handled: false }`.
 */
export async function tryHandleChatCommand(
  text: string,
  opts?: { channel?: string; channelKey?: string },
): Promise<ChatCommandResult> {
  const channel = opts?.channel ?? "cli";
  const channelKey = opts?.channelKey || `${channel}:main`;

  const { tryConsumeVoicePending, handleVoiceCommand } = await import("./voice-settings.js");
  const pending = await tryConsumeVoicePending(channelKey, text);
  if (pending) return pending;

  const parsed = parseSlash(text);
  if (!parsed) return { handled: false };

  const { cmd, args } = parsed;

  switch (cmd) {
    case "help":
    case "commands":
    case "start":
      return { handled: true, reply: helpText() };
    case "status":
      return { handled: true, reply: await statusText() };
    case "switchmodel":
    case "model":
    case "models":
      return switchModel(args);
    case "switchavatar":
    case "avatar":
    case "avatars":
      return switchAvatar(args);
    case "switchname":
    case "name":
    case "rename":
      return switchName(args);
    case "voice":
      return handleVoiceCommand(args, channelKey);
    case "cwd":
    case "workspace": {
      if (!args) {
        return { handled: true, reply: "Укажи папку: /cwd C:\\Projects\\app — задачи кодирования пойдут в неё." };
      }
      const { stat } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      const target = resolve(args);
      try {
        if (!(await stat(target)).isDirectory()) throw new Error("not a directory");
      } catch {
        return { handled: true, reply: `Папка недоступна: ${target}` };
      }
      return {
        handled: true,
        reply: `✅ Рабочая папка проекта: ${target}`,
        effects: { workspaceChanged: target },
      };
    }
    default:
      return { handled: false };
  }
}

/** Telegram BotFather-style command list for setMyCommands. */
export const TELEGRAM_BOT_COMMANDS = [
  { command: "help", description: "Список команд" },
  { command: "status", description: "Модель / аватар / голос" },
  { command: "switchmodel", description: "Сменить LLM" },
  { command: "switchavatar", description: "Сменить аватар" },
  { command: "switchname", description: "Переименовать агента" },
  { command: "voice", description: "Голос: меню / API / voice id" },
];
