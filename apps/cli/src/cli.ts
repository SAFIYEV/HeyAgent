import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  PRODUCT_NAME,
  CLI_NAME,
  loadConfig,
  saveConfig,
  GATEWAY_DEFAULT_PORT,
  normalizeLocale,
  resolveLocale,
  type SupportedLocale,
} from "@heyagent/shared";
import {
  createIdentity,
  loadIdentity,
  isOnboarded,
  ensureWorkspace,
  AVATAR_CATALOG,
  PERSONAS,
  printAvatarGallery,
  printAvatarPreview,
  enableTerminalColor,
  AvatarAnimator,
  type AvatarId,
} from "@heyagent/identity";
import {
  PROVIDERS,
  saveProviderCredentials,
  smokeTest,
  listRemoteModels,
  listModelIds,
  formatModelRef,
  defaultFallbackChain,
  resolveModelRef,
  BEDROCK_MARKETPLACE_OFFERS,
  bedrockMarketplaceUrl,
  listModelAliases,
} from "@heyagent/models";
import { AgentRuntime } from "@heyagent/agent";
import {
  IntegrationsHub,
  ensureHeyAgentHome,
  openUrl,
  GOOGLE_OAUTH_REDIRECT,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  findGoogleClientSecretJson,
  loadGoogleClientSecretJson,
  makePkce,
  waitForOAuthCode,
} from "@heyagent/integrations";
import { startGateway } from "@heyagent/gateway";

const agent = new AgentRuntime();

export async function runCli(args: string[]): Promise<void> {
  await ensureHeyAgentHome();

  const [cmd, ...rest] = args;

  if (!cmd) {
    await cmdChat();
    return;
  }

  if (cmd === "help" || cmd === "--help") {
    printHelp();
    return;
  }

  switch (cmd) {
    case "avatars":
      enableTerminalColor();
      printAvatarGallery();
      break;
    case "onboard":
      await cmdOnboard(rest);
      break;
    case "chat":
      await cmdChat(rest[0]);
      break;
    case "ask":
      await cmdAsk(...parseCwdArgs(rest));
      break;
    case "code":
      await cmdCode(...parseCwdArgs(rest));
      break;
    case "status":
      await cmdStatus();
      break;
    case "models":
      await cmdModels(rest);
      break;
    case "connect":
      await cmdConnect(rest);
      break;
    case "integrations":
      await cmdIntegrations(rest);
      break;
    case "telegram":
      await cmdTelegram(rest);
      break;
    case "voice":
      await cmdVoice(rest);
      break;
    case "gateway":
      await cmdGateway(rest);
      break;
    case "daemon":
      await cmdDaemon(rest);
      break;
    case "eval":
      await cmdEval(rest);
      break;
    case "metrics":
      await cmdMetrics();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
${PRODUCT_NAME} — your local AI agent for the whole computer

Usage: ${CLI_NAME} <command>

Commands:
  onboard [--locale ru|en]  Set language, agent name, avatar, and model
  avatars              Show all pixel skins
  chat [sessionId]     Interactive chat in terminal (/cwd sets project folder)
  ask <message> [--cwd <dir>]   Single question/task (coding defaults to current folder)
  code <task> [--cwd <dir>]     Coding agent on a project: edit, run, test, commit
  status               Show agent identity and config status
  models list|set|auth|test|fallbacks|marketplace|aliases   LLM + Bedrock offers
  connect <service>    Connect Google Workspace, Gmail, or GitHub
  integrations status  Show connected services
  telegram setup|pair|status  Configure Telegram bot
  voice                       ElevenLabs + озвучка (chat и Telegram)
  gateway start|stop|restart   Gateway daemon (Telegram + HTTP)
  daemon install       Print install instructions for auto-start
  eval [--all|--id ID|--tag TAG] [--json]   Mock eval pack (P0 metrics)
  metrics              Harness success rates
`);
}

async function cmdMetrics(): Promise<void> {
  const { harnessMetricsReport } = await import("@heyagent/agent");
  console.log(await harnessMetricsReport());
}

async function cmdEval(args: string[]): Promise<void> {
  const { runEvalPack, formatEvalReport, listScenarios } = await import("@heyagent/agent");
  let id: string | undefined;
  let tag: string | undefined;
  let json = false;
  let listOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (a === "--list") listOnly = true;
    else if (a === "--all") {
      /* default */
    } else if (a === "--id" && args[i + 1]) id = args[++i];
    else if (a === "--tag" && args[i + 1]) tag = args[++i];
    else if (a.startsWith("--id=")) id = a.slice(5);
    else if (a.startsWith("--tag=")) tag = a.slice(6);
    else if (!a.startsWith("-")) id = a;
  }
  if (listOnly) {
    for (const s of listScenarios({ id, tag })) {
      console.log(`${s.id}\t${s.mode}\t${s.name}`);
    }
    return;
  }
  const report = await runEvalPack({ id, tag, live: false });
  console.log(formatEvalReport(report, json));
  if (report.failed > 0) process.exitCode = 1;
}

function requestedOnboardingLocale(args: string[]): SupportedLocale | null {
  const inline = args.find((arg) => arg.startsWith("--locale="));
  const explicit = inline?.slice("--locale=".length) ??
    (args.includes("--locale") ? args[args.indexOf("--locale") + 1] : undefined);
  return explicit === "ru" || explicit === "en" ? explicit : null;
}

function onboardingText(locale: SupportedLocale) {
  return locale === "ru"
    ? {
        welcome: `Добро пожаловать в ${PRODUCT_NAME}!`,
        name: "Выберите имя агента: ",
        avatars: "Пиксельные аватары:",
        avatar: "Выберите номер аватара (1–12): ",
        invalidAvatar: "Неверный номер аватара.",
        selected: "Выбран",
        personas: "Характер:",
        persona: "Выберите характер (1–3, по умолчанию friendly): ",
        created: "Агент создан",
        workspace: "Рабочая папка (SOUL/AGENTS/MEMORY)",
        providers: "Провайдеры моделей:",
        provider: "Выберите номер провайдера: ",
        apiKey: "Введите API-ключ",
        region: "Регион AWS [us-east-1]: ",
        models: "Модели:",
        defaultModel: "Модель по умолчанию",
        modelOk: "Модель подключена",
        modelFailed: "Ошибка проверки модели",
        done: `Готово! Попробуйте: ${CLI_NAME} chat`,
      }
    : {
        welcome: `Welcome to ${PRODUCT_NAME}!`,
        name: "Choose a name for your agent: ",
        avatars: "Pixel avatars:",
        avatar: "Pick avatar number (1–12): ",
        invalidAvatar: "Invalid avatar choice.",
        selected: "Selected",
        personas: "Personas:",
        persona: "Pick persona (1–3, default friendly): ",
        created: "Agent created",
        workspace: "Workspace (SOUL/AGENTS/MEMORY)",
        providers: "Model providers:",
        provider: "Pick provider number: ",
        apiKey: "Enter API key for",
        region: "AWS region [us-east-1]: ",
        models: "Models:",
        defaultModel: "Default model",
        modelOk: "Model OK",
        modelFailed: "Model test failed",
        done: `Done! Try: ${CLI_NAME} chat`,
      };
}

async function configureVoiceDuringOnboarding(
  rl: ReturnType<typeof readline.createInterface>,
  locale: SupportedLocale,
): Promise<void> {
  const ru = locale === "ru";
  console.log(ru ? "\n--- Голос ElevenLabs ---" : "\n--- ElevenLabs voice ---");
  console.log(
    ru
      ? "Необязательно. Можно подключить позже командой hey voice key."
      : "Optional. You can connect it later with hey voice key.",
  );
  const answer = (
    await rl.question(
      ru
        ? "Добавить API-ключ ElevenLabs сейчас? [д/Н]: "
        : "Add an ElevenLabs API key now? [y/N]: ",
    )
  ).trim().toLowerCase();
  if (!["y", "yes", "д", "да"].includes(answer)) return;

  const apiKey = (await rl.question("ElevenLabs API key: ")).trim();
  if (!apiKey) return;
  const voiceId = (
    await rl.question("Voice ID [Enter = Rachel 21m00Tcm4TlvDq8ikWAM]: ")
  ).trim();
  const { saveElevenLabsCreds, setVoiceReplyBoth } = await import("@heyagent/agent");
  await saveElevenLabsCreds({ apiKey, ...(voiceId ? { voiceId } : {}) });
  const enable = (
    await rl.question(
      ru ? "Включить озвучку ответов сейчас? [д/Н]: " : "Enable voice replies now? [y/N]: ",
    )
  ).trim().toLowerCase();
  if (["y", "yes", "д", "да"].includes(enable)) {
    await setVoiceReplyBoth(true);
    console.log(
      ru
        ? "Голос включён для hey chat и Telegram."
        : "Voice enabled for hey chat and Telegram.",
    );
  } else {
    console.log(
      ru
        ? "Ключ сохранён. Включить позже: hey voice on или /voice → 1"
        : "Key saved. Enable later: hey voice on or /voice → 1",
    );
  }
}

async function cmdOnboard(args: string[] = []): Promise<void> {
  const rl = readline.createInterface({ input, output });

  const requestedLocale = requestedOnboardingLocale(args);
  let locale: SupportedLocale;
  if (requestedLocale) {
    locale = requestedLocale;
  } else {
    console.log("\nChoose your language / Выберите язык:\n\n  1. Русский\n  2. English");
    const choice = (await rl.question("\n1 / 2 [1]: ")).trim().toLowerCase();
    locale = choice === "2" || choice === "en" ? "en" : "ru";
  }
  const text = onboardingText(locale);

  console.log(`\n${text.welcome}\n`);

  const name = await rl.question(text.name);
  console.log(`\n${text.avatars}\n`);
  printAvatarGallery();
  const avatarChoice = await rl.question(text.avatar);
  const avatar = AVATAR_CATALOG[Number(avatarChoice) - 1];
  if (!avatar) {
    console.error(text.invalidAvatar);
    rl.close();
    process.exit(1);
  }
  console.log(`\n${text.selected}: ${avatar.label}`);
  printAvatarPreview(avatar.id);
  console.log();

  console.log(`\n${text.personas}`);
  Object.keys(PERSONAS).forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  const personaChoice = await rl.question(text.persona);
  const personaKeys = Object.keys(PERSONAS);
  const persona = personaKeys[Number(personaChoice) - 1] ?? "friendly";

  const config = await loadConfig();
  config.user = { ...config.user, locale: normalizeLocale(locale) };
  await saveConfig(config);

  const identity = await createIdentity(name, avatar.id, persona, locale);
  const ws = await ensureWorkspace(locale);
  console.log(`\n${text.created}: "${identity.name}" (${identity.avatarId}).`);
  console.log(`${text.workspace}: ${ws}\n`);

  console.log(text.providers);
  const modelProviders = PROVIDERS.filter((p) => p.id !== "elevenlabs");
  modelProviders.forEach((p: (typeof PROVIDERS)[number], i: number) =>
    console.log(`  ${i + 1}. ${p.name} (${p.id})`),
  );
  const providerChoice = await rl.question(`\n${text.provider}`);
  const provider = modelProviders[Number(providerChoice) - 1];
  if (!provider) {
    rl.close();
    return;
  }

  if (provider.authType === "api_key") {
    const keyPrompt =
      provider.id === "bedrock"
        ? "Amazon Bedrock API key: "
        : `${text.apiKey} ${provider.name}: `;
    const key = await rl.question(keyPrompt);
    let baseUrl: string | undefined;
    if (provider.id === "bedrock") {
      const region = (await rl.question(text.region)).trim() || "us-east-1";
      baseUrl = `https://bedrock-mantle.${region}.api.aws/v1`;
      console.log(`Endpoint: ${baseUrl}`);
    }
    await saveProviderCredentials(provider.id, {
      apiKey: key,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }

  const models = await listRemoteModels(provider.id);
  console.log(`\n${text.models}:`, models.slice(0, 40).join(", ") + (models.length > 40 ? " …" : ""));
  const model = await rl.question(`${text.defaultModel} [${models[0]}]: `) || models[0];

  const primary = { provider: provider.id, model };
  config.models = {
    defaultProvider: provider.id,
    defaultModel: model,
    fallbacks: defaultFallbackChain(primary).map((r) => `${r.provider}/${r.model}`),
  };
  config.agent = {
    maxIterations: 32,
    missionMaxIterations: 80,
    toolLoopLimit: 8,
    ...config.agent,
  };
  await saveConfig(config);

  const test = await smokeTest({ provider: provider.id, model });
  console.log(
    test.ok
      ? `\n${text.modelOk}: ${test.message}`
      : `\n${text.modelFailed}: ${test.message}`,
  );

  await configureVoiceDuringOnboarding(rl, locale);
  rl.close();
  console.log(`\n${text.done}\n`);
}

async function cmdChat(sessionId?: string): Promise<void> {
  const locale = resolveLocale(await loadConfig());
  if (!isOnboarded()) {
    console.error(
      locale === "ru"
        ? "Агент не настроен. Запустите: hey onboard"
        : "Not onboarded. Run: hey onboard",
    );
    process.exit(1);
  }

  enableTerminalColor();
  const identity = await loadIdentity();
  const rl = readline.createInterface({ input, output });
  let currentSession = sessionId;

  console.log(
    locale === "ru"
      ? `\nЧат с ${identity?.name}. Для выхода: /exit.`
      : `\nChat with ${identity?.name}. Type /exit to quit.`,
  );
  console.log(
    `Commands: /help  /switchmodel  /switchavatar  /voice  /status  /exit\n`,
  );
  if (identity?.avatarId) {
    printAvatarPreview(identity.avatarId as AvatarId);
    console.log(`  ${identity.name}  [${identity.avatarId}]\n`);
  }

  let sessionModel: import("@heyagent/models").ModelRef | undefined;
  let liveIdentity = identity;
  let sessionWorkspace: string | undefined;

  while (true) {
    let line: string;
    try {
      line = await rl.question(`${liveIdentity?.name}> `);
    } catch {
      // EOF (for example, piping one command from a script) is a normal exit.
      break;
    }
    if (line === "/exit" || line === "/quit") break;
    if (!line.trim()) continue;

    const { tryHandleChatCommand } = await import("@heyagent/agent");
    const cmd = await tryHandleChatCommand(line, {
      channel: "cli",
      channelKey: "cli:main",
    });
    if (cmd.handled) {
      if (cmd.reply) console.log(`\n${cmd.reply}\n`);
      if (cmd.effects?.modelChanged) sessionModel = cmd.effects.modelChanged;
      if (cmd.effects?.workspaceChanged) sessionWorkspace = cmd.effects.workspaceChanged;
      if (cmd.effects?.identityChanged) {
        liveIdentity = await loadIdentity();
        if (liveIdentity?.avatarId) {
          printAvatarPreview(liveIdentity.avatarId as AvatarId);
          console.log(`  ${liveIdentity.name}  [${liveIdentity.avatarId}]\n`);
        }
      }
      continue;
    }

    const animator = liveIdentity?.avatarId
      ? new AvatarAnimator(liveIdentity.avatarId as AvatarId)
      : null;

    try {
      const result = await agent.run(line, {
        sessionId: currentSession,
        channel: "cli",
        modelRef: sessionModel,
        workspaceDir: sessionWorkspace,
        onApprovalNeeded: async (desc: string, toolName?: string) => {
          animator?.stop();
          console.log(`\n📋 ${desc}\n`);
          const answer = await rl.question(
            `Approve ${toolName || "action"}? [y/N] `,
          );
          return answer.toLowerCase() === "y";
        },
        onStatus: (s, detail) => {
          if (animator) {
            const animationState =
              s === "error" ? "idle" : s === "skipped" ? "done" : s;
            animator.setState(animationState, detail);
          }
          else process.stderr.write(`[${s}${detail ? `: ${detail}` : ""}]\n`);
        },
      });
      animator?.stop();
      currentSession = result.sessionId;
      console.log(`\n${result.response}\n`);
      if (result.toolCallsExecuted.length) {
        console.log(`(tools: ${result.toolCallsExecuted.join(", ")})\n`);
      }
      await maybeCliSpeak(result.response);
    } catch (err) {
      animator?.stop();
      console.error(err instanceof Error ? err.message : err);
    }
  }

  rl.close();
}

async function maybeCliSpeak(response: string): Promise<void> {
  try {
    const cfg = await loadConfig();
    if (cfg.cli?.replyMode !== "both") return;
    const { speakAgentReply } = await import("@heyagent/computer");
    const r = await speakAgentReply(response, { wait: false });
    if (
      process.env.HEYAGENT_DEBUG === "1" &&
      (r.startsWith("skip:") || r.startsWith("ERROR"))
    ) {
      console.warn(`[voice debug] ${r}`);
    }
  } catch (err) {
    if (process.env.HEYAGENT_DEBUG === "1") {
      console.warn("[voice debug]", err instanceof Error ? err.message : err);
    }
  }
}

async function cmdVoice(args: string[]): Promise<void> {
  const {
    voiceStatusText,
    voiceMenuText,
    saveElevenLabsCreds,
    handleVoiceCommand,
  } = await import("@heyagent/agent");
  const action = (args[0] || "").toLowerCase();

  if (!action || action === "menu" || action === "help") {
    console.log(await voiceStatusText());
    console.log();
    console.log(voiceMenuText());
    console.log();
    console.log("CLI: hey voice key | hey voice id | hey voice on|off|status");
    console.log("В чате: /voice  →  потом 1 / 2 / 3");
    return;
  }

  if (action === "key" || action === "api") {
    const rl = readline.createInterface({ input, output });
    const key = (await rl.question("ElevenLabs API key: ")).trim();
    const voiceId = (await rl.question("Voice ID [Enter = keep/default]: ")).trim();
    rl.close();
    if (!key) {
      console.error("Ключ пустой.");
      process.exit(1);
    }
    await saveElevenLabsCreds({
      apiKey: key,
      ...(voiceId ? { voiceId } : {}),
    });
    console.log("ElevenLabs сохранён (~/.heyagent/credentials/elevenlabs.json).");
    console.log("Общий для hey chat и Telegram. Включить: hey voice on");
    return;
  }

  if (action === "id") {
    const rl = readline.createInterface({ input, output });
    const voiceId = (await rl.question("ElevenLabs Voice ID: ")).trim();
    rl.close();
    if (!voiceId) {
      console.error("Пусто.");
      process.exit(1);
    }
    await saveElevenLabsCreds({ voiceId });
    console.log(`Voice ID: ${voiceId}`);
    return;
  }

  if (action === "on" || action === "off" || action === "status" || /^[1234]$/.test(action)) {
    const rest = args.slice(1).join(" ");
    const r = await handleVoiceCommand(
      rest ? `${action} ${rest}` : action,
      "cli:main",
    );
    console.log(r.reply);
    return;
  }

  // hey voice 2 sk_xxx
  const r = await handleVoiceCommand(args.join(" "), "cli:main");
  console.log(r.reply);
}

/** Split trailing "--cwd <dir>" (or --cwd=<dir>) from free-text args. */
function parseCwdArgs(args: string[]): [string, string | undefined] {
  const list = [...args];
  let cwd: string | undefined;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "--cwd" && list[i + 1]) {
      cwd = list[i + 1];
      list.splice(i, 2);
      break;
    }
    if (list[i]?.startsWith("--cwd=")) {
      cwd = list[i]!.slice("--cwd=".length);
      list.splice(i, 1);
      break;
    }
  }
  return [list.join(" "), cwd];
}

async function cmdAsk(message: string, cwd?: string): Promise<void> {
  if (!message) {
    console.error("Usage: hey ask <message> [--cwd <project folder>]");
    process.exit(1);
  }
  const result = await agent.run(message, { channel: "cli", workspaceDir: cwd });
  console.log(result.response);
  await maybeCliSpeak(result.response);
}

async function cmdCode(message: string, cwd?: string): Promise<void> {
  if (!message) {
    console.error("Usage: hey code <coding task> [--cwd <project folder>]");
    console.error("Example: hey code \"исправь падающий тест в auth\" --cwd C:\\Projects\\app");
    process.exit(1);
  }
  const workspaceDir = cwd ?? process.cwd();
  console.error(`[workspace: ${workspaceDir}]`);
  const result = await agent.run(message, { channel: "cli", workspaceDir });
  console.log(result.response);
  await maybeCliSpeak(result.response);
}

async function cmdStatus(): Promise<void> {
  const identity = await loadIdentity();
  const config = await loadConfig();
  const hub = new IntegrationsHub();
  const integrations = await hub.getStatus();

  console.log(`\n${PRODUCT_NAME} Status\n`);
  if (identity) {
    console.log(`Agent: ${identity.name} (${identity.avatarId})`);
    printAvatarPreview(identity.avatarId as AvatarId);
    console.log(`Persona: ${identity.persona}`);
  } else {
    console.log("Agent: not onboarded (run: hey onboard)");
  }
  if (config.models?.defaultProvider) {
    console.log(
      `Model: ${config.models.defaultProvider}/${config.models.defaultModel}`,
    );
  }
  console.log("\nIntegrations:");
  for (const i of integrations) {
    console.log(`  ${i.name}: ${i.connected ? "connected" : "not connected"}`);
  }
  console.log();
}

async function cmdModels(sub: string[]): Promise<void> {
  const [action, ...rest] = sub;

  if (!action || action === "list") {
    for (const p of PROVIDERS.filter((x) => x.id !== "elevenlabs")) {
      console.log(`${p.id}: ${p.name}`);
      console.log(`  ${listModelIds(p).join(", ")}`);
    }
    console.log("\nShortcuts: hey models set opus5 | sonnet5 | haiku | gpt54 | deepseekv3 | gpt-4o | o3");
    console.log("Bedrock Marketplace offers: hey models marketplace");
    return;
  }

  if (action === "aliases") {
    console.log("Friendly aliases → model:");
    for (const a of listModelAliases()) {
      console.log(`  ${a}  →  ${formatModelRef(resolveModelRef(a))}`);
    }
    return;
  }

  if (action === "marketplace") {
    console.log(
      "AWS Marketplace — Accept offer в браузере (агент НЕ может сделать это за тебя).\n",
    );
    console.log("Haiku 4.5 (то письмо prod-xdkflymybwmvi) ты уже принял — ок.\n");
    for (const o of BEDROCK_MARKETPLACE_OFFERS) {
      console.log(`${o.name}`);
      console.log(`  model: ${o.modelHint}`);
      console.log(`  ${bedrockMarketplaceUrl(o.productId)}`);
      console.log();
    }
    console.log("После Accept: hey models set fable5   (или opus5 / sonnet5 / …)");
    return;
  }

  if (action === "set") {
    const ref = rest[0];
    if (!ref) {
      console.error("Usage: hey models set <provider/model|alias>");
      console.error("  hey models set fable5");
      console.error("  hey models set bedrock/us.anthropic.claude-opus-5");
      process.exit(1);
    }
    const parsed = resolveModelRef(ref);
    const config = await loadConfig();
    const autoFb = defaultFallbackChain(parsed).map((r) => `${r.provider}/${r.model}`);
    config.models = {
      ...config.models,
      defaultProvider: parsed.provider,
      defaultModel: parsed.model,
      fallbacks: config.models?.fallbacks?.length ? config.models.fallbacks : autoFb,
    };
    config.agent = {
      maxIterations: 32,
      missionMaxIterations: 80,
      toolLoopLimit: 8,
      ...config.agent,
    };
    await saveConfig(config);
    console.log(`Default model set to ${formatModelRef(parsed)}`);
    if (config.models.fallbacks?.length) {
      console.log(`Fallbacks: ${config.models.fallbacks.join(" → ")}`);
    }
    if (parsed.provider === "bedrock" && /^anthropic\./i.test(parsed.model)) {
      console.log(
        "Claude on Mantle uses Messages API. If 403 — Accept offer: hey models marketplace",
      );
    }
    return;
  }

  if (action === "fallbacks") {
    const config = await loadConfig();
    if (rest[0] === "clear") {
      config.models = { ...config.models, fallbacks: [] };
      await saveConfig(config);
      console.log("Fallbacks cleared (built-in defaults still apply at runtime).");
      return;
    }
    if (rest.length) {
      config.models = { ...config.models, fallbacks: rest };
      await saveConfig(config);
      console.log(`Fallbacks set: ${rest.join(" → ")}`);
      return;
    }
    const list = config.models?.fallbacks ?? [];
    console.log(
      list.length
        ? `Fallbacks: ${list.join(" → ")}`
        : "No configured fallbacks (runtime uses provider defaults).",
    );
    return;
  }

  if (action === "auth") {
    const providerId = rest[0];
    const provider = PROVIDERS.find((p: (typeof PROVIDERS)[number]) => p.id === providerId);
    if (!provider) {
      console.error(`Unknown provider: ${providerId}`);
      process.exit(1);
    }
    const rl = readline.createInterface({ input, output });
    const keyPrompt =
      provider.id === "bedrock"
        ? "Amazon Bedrock API key (AWS console → Bedrock → API keys): "
        : `API key for ${provider.name}: `;
    const key = await rl.question(keyPrompt);
    let baseUrl = "";
    if (provider.id === "custom") {
      baseUrl = await rl.question("Base URL (OpenAI-compatible): ");
    } else if (provider.id === "bedrock") {
      const region = (await rl.question("AWS region [us-east-1]: ")).trim() || "us-east-1";
      baseUrl = `https://bedrock-mantle.${region}.api.aws/v1`;
    }
    rl.close();
    await saveProviderCredentials(providerId, {
      apiKey: key,
      ...(baseUrl ? { baseUrl } : {}),
    });
    console.log(`Credentials saved for ${provider.name}`);
    if (provider.id === "bedrock") {
      const remote = await listRemoteModels("bedrock");
      if (remote.length) {
        console.log("Available on your account:", remote.slice(0, 20).join(", "));
      }
      console.log("Set model, e.g.:  hey models set bedrock/us.anthropic.claude-sonnet-4-6");
      console.log("Or Nova:           hey models set bedrock/amazon.nova-lite-v1:0");
    }
    return;
  }

  if (action === "test") {
    const config = await loadConfig();
    const ref = {
      provider: config.models?.defaultProvider ?? "openai",
      model: config.models?.defaultModel ?? "gpt-4.1-mini",
    };
    const result = await smokeTest(ref);
    console.log(result.ok ? `OK: ${result.message}` : `FAIL: ${result.message}`);
    return;
  }

  console.error("Usage: hey models list|set|auth|test|fallbacks|marketplace|aliases […]");
}

async function cmdConnect(sub: string[]): Promise<void> {
  const service = sub[0];
  const hub = new IntegrationsHub();
  const rl = readline.createInterface({ input, output });

  if (service === "gmail") {
    console.log(`
Gmail — простой способ (без OAuth / redirect / Client ID):

1) Открой: https://myaccount.google.com/apppasswords
   (нужна 2FA на аккаунте Google)
2) Создай пароль приложения → «Почта»
3) Скопируй 16 символов
`);
    openUrl("https://myaccount.google.com/apppasswords");

    const email = (await rl.question("Gmail: ")).trim();
    if (!email.includes("@")) {
      console.error("Нужен email.");
      rl.close();
      return;
    }

    const appPassword = (await rl.question("Пароль приложения (16 символов): ")).trim();
    if (!appPassword || appPassword.replace(/\s+/g, "").length < 12) {
      console.error("Нужен пароль приложения с https://myaccount.google.com/apppasswords");
      rl.close();
      return;
    }

    console.log("Проверяю почту...");
    const result = await hub.saveGmailAppPassword(email, appPassword);
    if (result.startsWith("ERROR")) {
      console.error(result);
    } else {
      console.log("Gmail connected.");
      console.log(result);
    }
    rl.close();
    return;
  }

  if (service === "google") {
    console.log(`
Google Workspace — Docs, Drive, Sheets, Slides и Calendar.
Gmail сюда не входит: для почты используй npx hey connect gmail.
`);
    try {
      let credentialsPath = await findGoogleClientSecretJson(sub[1]);
      if (!credentialsPath) {
        console.log([
          "Нужен бесплатный OAuth-клиент Google типа Desktop app (один раз):",
          "1) Создай OAuth client ID → Desktop app на открывшейся странице.",
          "2) Скачай JSON. HeyAgent автоматически найдёт его в Downloads.",
          "3) Вернись сюда и нажми Enter или вставь путь к JSON.",
          "",
          "Если Google попросит, настрой OAuth consent screen и добавь свой email как test user.",
        ].join("\n"));
        openUrl("https://console.cloud.google.com/apis/credentials");
        const entered = (await rl.question("\nПуть к client_secret_*.json (Enter = найти в Downloads): ")).trim();
        credentialsPath = await findGoogleClientSecretJson(entered || undefined);
      }
      if (!credentialsPath) {
        console.error("OAuth JSON не найден. Скачай Desktop app JSON и повтори: npx hey connect google");
        rl.close();
        return;
      }

      const client = await loadGoogleClientSecretJson(credentialsPath);
      const pkce = makePkce();
      const authUrl = buildGoogleAuthUrl(
        client.clientId,
        GOOGLE_OAUTH_REDIRECT,
        pkce.challenge,
      );
      console.log(`Использую OAuth JSON: ${credentialsPath}`);
      console.log("Открываю Google. Разреши доступ к Workspace — callback завершится автоматически.");
      console.log(`Если браузер не открылся, открой эту ссылку вручную:\n${authUrl}\n`);
      const codePromise = waitForOAuthCode(GOOGLE_OAUTH_REDIRECT);
      openUrl(authUrl);
      const code = await codePromise;
      const token = await exchangeGoogleCode({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code,
        redirectUri: GOOGLE_OAUTH_REDIRECT,
        codeVerifier: pkce.verifier,
      });
      await hub.saveGoogleCredentials({ ...token, mode: "oauth" });
      console.log("Google Workspace connected.");
      console.log(await hub.testGoogleWorkspaceConnection());
    } catch (error) {
      console.error(`Google connection failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rl.close();
    }
    return;
  }

  if (service === "github") {
    const token = await rl.question("GitHub personal access token: ");
    await hub.saveGitHubToken(token);
    console.log("GitHub connected.");
    rl.close();
    return;
  }

  rl.close();
  console.error("Usage: hey connect google|gmail|github");
}

async function cmdIntegrations(sub: string[]): Promise<void> {
  const hub = new IntegrationsHub();
  const statuses = await hub.getStatus();
  if (!sub[0] || sub[0] === "status") {
    for (const s of statuses) {
      console.log(`${s.name}: ${s.connected ? "connected" : "needs auth"}${s.connectedAt ? ` (since ${s.connectedAt})` : ""}`);
    }
    return;
  }
}

async function cmdTelegram(sub: string[]): Promise<void> {
  const [action] = sub;
  const rl = readline.createInterface({ input, output });
  const config = await loadConfig();

  if (action === "setup") {
    console.log(`
Telegram-бот = пульт управления HeyAgent с телефона.

1) Открой @BotFather в Telegram
2) /newbot → получи токен
3) Вставь токен ниже
`);
    const token = await rl.question("Telegram bot token: ");
    config.telegram = { enabled: true, botToken: token.trim(), allowedChatIds: [] };
    await saveConfig(config);
    console.log(`
Готово. Дальше:
  1) Найди своего бота в Telegram и нажми Start / напиши /start
  2) npx hey telegram pair
  3) npx hey gateway start
  4) Пиши боту задачи как в чате (погода, блокнот, telegram Ренату и т.д.)
`);
    rl.close();
    return;
  }

  if (action === "pair") {
    const token = config.telegram?.botToken;
    if (!token) {
      console.error("Сначала: npx hey telegram setup");
      rl.close();
      process.exit(1);
    }

    console.log(`
Сейчас привяжем ТОЛЬКО твой чат к боту.

1) Открой своего бота в Telegram
2) Напиши ему: /start
3) Нажми Enter здесь
`);
    await rl.question("Написал /start боту? Enter...");

    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20`);
    const data = (await res.json()) as {
      ok: boolean;
      result?: {
        message?: { chat: { id: number; type: string; username?: string; first_name?: string } };
      }[];
    };

    if (!data.ok || !data.result?.length) {
      console.error("Не вижу сообщений. Напиши боту /start и снова: npx hey telegram pair");
      rl.close();
      process.exit(1);
    }

    const chats = new Map<number, string>();
    for (const u of data.result) {
      const c = u.message?.chat;
      if (!c || c.type !== "private") continue;
      const label = c.username ? `@${c.username}` : c.first_name || String(c.id);
      chats.set(c.id, label);
    }

    if (chats.size === 0) {
      console.error("Нет личных сообщений боту. Напиши боту в личку /start.");
      rl.close();
      process.exit(1);
    }

    const entries = [...chats.entries()];
    if (entries.length === 1) {
      const [id, label] = entries[0];
      config.telegram = { ...config.telegram, enabled: true, allowedChatIds: [id] };
      await saveConfig(config);
      console.log(`Привязан чат: ${label} (id ${id})`);
      console.log("Запусти: npx hey gateway start");
      console.log("Потом пиши боту в Telegram обычным текстом.");
      rl.close();
      return;
    }

    console.log("Найдено несколько чатов:");
    entries.forEach(([id, label], i) => console.log(`  ${i + 1}. ${label} (${id})`));
    const choice = await rl.question("Номер своего чата: ");
    const picked = entries[Number(choice) - 1];
    if (!picked) {
      console.error("Неверный выбор");
      rl.close();
      process.exit(1);
    }
    config.telegram = { ...config.telegram, enabled: true, allowedChatIds: [picked[0]] };
    await saveConfig(config);
    console.log(`Привязан чат: ${picked[1]} (${picked[0]})`);
    console.log("Запусти: npx hey gateway start");
    rl.close();
    return;
  }

  if (action === "status") {
    const tg = config.telegram;
    console.log(`Telegram enabled: ${tg?.enabled ? "yes" : "no"}`);
    console.log(`Bot token: ${tg?.botToken ? "set" : "missing"}`);
    console.log(`Allowed chats: ${(tg?.allowedChatIds ?? []).join(", ") || "(none — run pair)"}`);
    console.log(`Reply mode: ${tg?.replyMode === "both" ? "text+voice" : "text"}`);
    console.log(`Gateway must be running: npx hey gateway start`);
    rl.close();
    return;
  }

  if (action === "voice") {
    rl.close();
    console.log("Голос теперь общий (не только Telegram):");
    console.log("  hey voice key     — ElevenLabs API");
    console.log("  hey voice on|off  — вкл/выкл для chat + Telegram");
    console.log("  /voice            — меню в чате (1/2/3)");
    await cmdVoice(sub.slice(1));
    return;
  }

  rl.close();
  console.error("Usage: hey telegram setup|pair|status");
}

async function killGatewayPort(port: number): Promise<number[]> {
  const killed: number[] = [];
  if (process.platform === "win32") {
    const { execSync } = await import("node:child_process");
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`,
        { encoding: "utf-8" },
      );
      for (const line of out.split(/\r?\n/)) {
        const pid = Number(line.trim());
        if (!pid || Number.isNaN(pid)) continue;
        try {
          process.kill(pid);
          killed.push(pid);
        } catch {
          try {
            execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
            killed.push(pid);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* nothing on port */
    }
  } else {
    const { execSync } = await import("node:child_process");
    try {
      const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: "utf-8" });
      for (const line of out.split(/\r?\n/)) {
        const pid = Number(line.trim());
        if (!pid) continue;
        try {
          process.kill(pid);
          killed.push(pid);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* nothing */
    }
  }
  return [...new Set(killed)];
}

async function cmdGateway(sub: string[]): Promise<void> {
  const action = sub[0] || "start";
  const port = GATEWAY_DEFAULT_PORT;

  if (action === "stop") {
    const killed = await killGatewayPort(port);
    if (!killed.length) {
      console.log(`На порту ${port} никто не слушает — gateway уже остановлен.`);
    } else {
      console.log(`Остановлен gateway (PID: ${killed.join(", ")})`);
    }
    return;
  }

  if (action === "restart") {
    const killed = await killGatewayPort(port);
    if (killed.length) {
      console.log(`Убил старый процесс: ${killed.join(", ")}`);
      await new Promise((r) => setTimeout(r, 800));
    }
    await startGateway();
    return;
  }

  if (action === "start") {
    // If already up — don't crash with EADDRINUSE, just confirm
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        console.log(`Gateway уже работает на http://127.0.0.1:${port}`);
        console.log("Пиши боту в Telegram. Перезапуск: npx hey gateway restart");
        return;
      }
    } catch {
      /* not running — start fresh */
    }
    await startGateway();
    return;
  }

  console.error("Usage: hey gateway start|stop|restart");
  console.error("  start requests Admin UAC on Windows (full PC control).");
  console.error("  HEYAGENT_NO_ADMIN=1 — skip elevation");
  console.error("  HEYAGENT_BROWSER_GUEST=1 — guest browser profile instead of your logins");
}

async function cmdDaemon(sub: string[]): Promise<void> {
  if (sub[0] === "install") {
    const port = GATEWAY_DEFAULT_PORT;
    console.log(`
Install HeyAgent gateway as a background service:

Windows (Task Scheduler):
  schtasks /Create /TN "HeyAgent Gateway" /TR "node ${process.cwd()}\\apps\\gateway\\dist\\index.js" /SC ONLOGON

macOS (launchd):
  Save plist to ~/Library/LaunchAgents/com.heyagent.gateway.plist
  launchctl load ~/Library/LaunchAgents/com.heyagent.gateway.plist

Linux (systemd user):
  systemctl --user enable heyagent-gateway
  systemctl --user start heyagent-gateway

Gateway port: ${port}
`);
    return;
  }
  console.error("Usage: hey daemon install");
}
