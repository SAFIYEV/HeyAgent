/**
 * Single source of truth: first-match intent → domain / harness / slots.
 * Agent matchHarness must trust these harness hints, not re-guess the channel.
 */
import type { AgentKind, Domain, MissionKind } from "./types.js";

/** Concrete harness ids shared with @heyagent/agent match/execute. */
export type OrchHarnessHint =
  | "cancel"
  | "cron.schedule"
  | "open_tab"
  | "telegram_conversation"
  | "telegram_one_shot"
  | "docs.compose"
  | "notepad.compose"
  | "app.install"
  | "youtube.open.lesson"
  | "gmail"
  | "system.control"
  | "system.empty_recycle_bin"
  | "browser"
  | "research"
  | "research.digest"
  | "briefing.compose"
  | "mission.replay"
  | "mission.wait_owner"
  | "presentation.create"
  | "desktop.office"
  | "google.sheets"
  | "google.slides"
  | "desktop"
  | "coder"
  | "llm_loop";

export interface ClassifiedIntent {
  domain: Domain;
  agent: AgentKind;
  requiresUi: boolean;
  missionKind: MissionKind;
  priority: number;
  reason: string;
  slots: Record<string, string>;
  /** Concrete harness — dispatchAgent / matchHarness must honor this. */
  harness: OrchHarnessHint;
}

const RE_MESSENGER =
  /(телеграм|telegram|(^|\s)тг(\s|$)|whats\s?app|вотсап|ватсап|вайбер|viber|discord|дискорд)/i;
const RE_DOCS_WEB =
  /(google\s*docs?|docs\.google|гугл\s*док|google\s*documents?)/i;
const RE_GENRE_ESSAY = /(реферат|эссе|доклад|сочинен\w*)/i;
const RE_GENRE_ANY =
  /(реферат|эссе|доклад|сочинен\w*|рассказ|стишок|стих\w*|стать[юя]|текст|заметк\w*|список)/i;
const RE_MEDIA_YT =
  /(видос|видео|ролик|урок|tutorial|выпуск|серия|орел|орёл|решка|посмотр|клип|трек|песн|музык|дым|сигарет)/i;
const RE_SITE =
  /(сайт|страниц|википед|wikipedia|reddit|github\.com|http:\/\/|https:\/\/|\.org|\.com|\.ru)/i;
/** Windows Notepad / «блокнот» — not Notepad++ (installer). */
const RE_NOTEPAD = /блокнот|(?:^|[^a-z0-9+])notepad(?!\+\+)/i;
const RE_MAIL = /(письм|mail|email|имейл|мейл|gmail|почт|inbox)/i;
const RE_SYSTEM =
  /(громк|звук|volume|mute|ярк|brightness|хотспот|hotspot|wifi|wi-fi|bluetooth|блокир|lock|sleep|hibernate|shutdown|restart|перезагруз|выключ(и|ение)\s+(пк|комп|монитор)|корзин|recycle|тем\s*тем|night\s*light|обои|wallpaper)/i;
const RE_OPEN_VERB = /^(открой|открыть|покажи|включи|найди|поищи)(\s|$)/i;
const RE_BUILD_VERB = /(?:создай|сделай|разработай|собери|построй|реализуй|запрограммируй|build|create|implement|develop)/i;
const RE_SOFTWARE_OBJECT = /(?:бот|bot|приложен\w*|app\b|сервис\w*|скрипт\w*|программ\w*|сайт|website|веб.?приложен\w*|интеграц\w*|плагин\w*|api\b|автоматизац\w*|напомин\w*|парсер\w*|игр\w*|панел\w*|dashboard|дашборд\w*|интерфейс\w*|frontend|фронтенд|компонент\w*)/i;

const CONTACT_STOP =
  /^(на|по|в|во|к|ко|у|от|для|про|это|этот|тот|его|ее|их|ему|ей|ним|ней|вопрос|вопросы|тест|опрос|квиз|письмо|сообщение|чат|телеграм|telegram|тг|пожалуйста|мне|нам|там|сюда|туда|дым|сигарет|видео|урок|сайт|реферат|рассказ|стих|стишок|стать[юя]|доклад|эссе|текст|правду|сочинен\w*|заметк\w*|список|файл|документ|блокнот|notepad)$/i;

export function classifyIntent(text: string): ClassifiedIntent {
  const raw = text.trim();
  const t = raw.toLowerCase().replace(/ё/g, "е");
  const browserPref = /яндекс|yandex/i.test(t) ? "yandex" : "auto";

  // 1. Cancel
  // `\b` is ASCII-word based in JavaScript, so it does not match a Russian
  // word followed by whitespace/end-of-string. Keep cancellation deterministic.
  if (/^(стоп|отмена|cancel|хватит|останови|stop)(?:\s|$|[!.,;:])/i.test(raw)) {
    return intent("general", "general", false, "one_shot", 100, "cancel", { cancel: "1" }, "cancel");
  }

  // Heartbeat text contains examples such as "news digest" and "cron". They
  // are policy/checklist content, not user intent, so deterministic harnesses
  // must never execute them.
  if (/^\[SYSTEM HEARTBEAT\]/i.test(raw)) {
    return intent(
      "general",
      "general",
      false,
      "one_shot",
      99,
      "system heartbeat control turn",
      { systemHeartbeat: "1" },
      "llm_loop",
    );
  }

  // 2. Cron NL
  const cron = detectCronSignal(raw, t);
  if (cron) {
    return intent(
      "general",
      "general",
      false,
      "one_shot",
      96,
      "nl cron schedule",
      {
        cronEveryMinutes: String(cron.everyMinutes),
        cronPrompt: cron.prompt,
        cronName: cron.name,
      },
      "cron.schedule",
    );
  }

  // 3. Quiz / open tab
  const quiz = detectQuiz(raw, t);
  if (quiz) {
    return intent(
      "browser",
      "browser",
      true,
      "one_shot",
      quiz.bare ? 92 : 88,
      quiz.bare ? "continue open quiz" : "use already-open tab",
      {
        openTab: "1",
        tabQuery: quiz.tabQuery,
        browser: browserPref,
        ...(quiz.bare ? { quizContinue: "1" } : {}),
      },
      "open_tab",
    );
  }

  // 3b. Replay yesterday / last success
  if (
    /(как\s+вчера|сделай\s+как\s+вчера|повтори\s+(последн|ту\s+же)|сделай\s+снова|replay)/i.test(
      t,
    )
  ) {
    return intent(
      "general",
      "general",
      false,
      "one_shot",
      94,
      "replay last mission",
      { replay: "1", query: raw.slice(0, 160) },
      "mission.replay",
    );
  }

  // 3c. Wait for owner reply in control Telegram
  if (
    /(подожди\s+мой\s+ответ|жди\s+мой\s+ответ|wait\s+for\s+my\s+reply|пауза\s+до\s+ответа|потом\s+продолж)/i.test(
      t,
    )
  ) {
    return intent(
      "general",
      "general",
      false,
      "one_shot",
      93,
      "wait owner reply",
      { waitOwner: "1", query: raw.slice(0, 160) },
      "mission.wait_owner",
    );
  }

  // 4a. Briefing (news+mail+calendar) — before plain news digest
  if (
    /(брифинг|briefing).{0,40}/i.test(t) ||
    /(утренн\w*|вечерн\w*).{0,20}(брифинг|сводк|дайджест)/i.test(t) ||
    /(собери|сделай).{0,40}брифинг/i.test(t)
  ) {
    return intent(
      "research",
      "research",
      false,
      "research",
      92,
      "briefing compose",
      { query: raw.slice(0, 160), briefing: "1", reportPdf: "1" },
      "briefing.compose",
    );
  }

  // 4a2. Research digest / news → PDF
  if (
    /(новост|дайджест|digest|news).{0,40}(pdf|отч[её]т|report|собери|сбор)/i.test(t) ||
    /(собери|сделай|напиши|покажи|дай).{0,60}(новост|дайджест|digest|news)/i.test(t) ||
    /(pdf\s*отч[её]т|отч[её]т\s*pdf).{0,40}(новост|research|тем)/i.test(t) ||
    /^(собери|найди|покажи|дай)\s+(мне\s+)?(например\s+)?(последн\w*\s+|свеж\w*\s+)?новост/i.test(
      t,
    ) ||
    // "последние новости Азербайджана" — digest even without «собери» / PDF
    /^(?:мне\s+)?(?:последн[а-яё]*|свеж[а-яё]*|latest)\s+(?:новост[а-яё]*|news)(?:\s|$|[!.,;:])/i.test(
      t,
    ) ||
    /новост[а-яё]*.{0,40}(азербайджан|росси|украин|мир|world|сегодня)/i.test(t)
  ) {
    return intent(
      "research",
      "research",
      false,
      "research",
      91,
      "research digest → pdf",
      { query: raw.slice(0, 160), reportPdf: "1" },
      "research.digest",
    );
  }

  // 4b. Interactive presentation (HTML deck) — before google slides / powerpoint desktop
  if (
    /(сделай|создай|набери).{0,40}(презентац|слайд)/i.test(t) ||
    /(презентац|слайд\w*).{0,40}(про|по|about|on)\s+/i.test(t)
  ) {
    const wantsGoogleSlides = /google\s*slides|гугл\s*слайд/i.test(t);
    const wantsDesktopPpt = /(power\s*point|powerpoint|пауерпоинт)/i.test(t) && !wantsGoogleSlides;
    if (wantsGoogleSlides) {
      return intent(
        "browser",
        "browser",
        false,
        "one_shot",
        90,
        "google slides create",
        { query: raw.slice(0, 160), googleSlides: "1" },
        "google.slides",
      );
    }
    if (wantsDesktopPpt) {
      return intent(
        "desktop",
        "desktop",
        true,
        "one_shot",
        90,
        "desktop powerpoint",
        { officeApp: "powerpoint", query: raw.slice(0, 160), composeDoc: "1" },
        "desktop.office",
      );
    }
    return intent(
      "desktop",
      "desktop",
      false,
      "one_shot",
      90,
      "html presentation deck",
      { query: raw.slice(0, 160) },
      "presentation.create",
    );
  }

  // 4c. Google Sheets
  if (/(google\s*sheets?|гугл\s*таблиц|\.xlsx).{0,40}(создай|сделай|напиши)?/i.test(t) ||
      /(создай|сделай).{0,40}(таблиц\w*).{0,40}(google|гугл)/i.test(t)) {
    return intent(
      "browser",
      "browser",
      false,
      "one_shot",
      89,
      "google sheets",
      { query: raw.slice(0, 160), googleSheets: "1" },
      "google.sheets",
    );
  }

  // 4d. Desktop Office (Word / Excel / PowerPoint / WordPad) — not Google
  if (
    !RE_MESSENGER.test(t) &&
    !RE_DOCS_WEB.test(t) &&
    (/(в\s+)?(wordpad|вордпад)/i.test(t) ||
      (/(ms\s*word|\bword\b|ворд|\.docx)/i.test(t) && !/google/i.test(t)) ||
      (/(excel|эксель|\.xlsx)/i.test(t) && !/google/i.test(t)) ||
      (/(power\s*point|powerpoint)/i.test(t) && !/google/i.test(t)))
  ) {
    let officeApp = "word";
    if (/(wordpad|вордпад)/i.test(t)) officeApp = "wordpad";
    else if (/(excel|эксель)/i.test(t)) officeApp = "excel";
    else if (/(power\s*point|powerpoint)/i.test(t)) officeApp = "powerpoint";
    return intent(
      "desktop",
      "desktop",
      true,
      "one_shot",
      88,
      "desktop office app",
      { officeApp, query: raw.slice(0, 160), composeDoc: "1" },
      "desktop.office",
    );
  }

  // 4. Google Docs / essay-in-docs (before messaging — never Telegram «Реферат»)
  if (isGoogleDocsTask(t)) {
    return intent(
      "browser",
      "browser",
      false,
      "browser_tour",
      89,
      "google docs / essay in browser",
      { browser: browserPref, googleDocs: "1", query: raw.slice(0, 160), composeDoc: "1" },
      "docs.compose",
    );
  }

  // 5. Install/download a program (before notepad — «скачай notepad++» ≠ compose)
  if (isAppInstallTask(t)) {
    return intent(
      "desktop",
      "desktop",
      false,
      "one_shot",
      92,
      "install / download program",
      { appInstall: "1", query: raw.slice(0, 160) },
      "app.install",
    );
  }

  // 6. Notepad / open блокнот (before open-content browser)
  if (RE_NOTEPAD.test(t) && !RE_MESSENGER.test(t) && !isAppInstallTask(t)) {
    const genre = detectNoteGenre(t);
    return intent(
      "desktop",
      "desktop",
      true,
      "one_shot",
      88,
      "notepad / local file compose",
      {
        composeDoc: "1",
        query: raw.slice(0, 160),
        noteGenre: genre,
      },
      "notepad.compose",
    );
  }

  // 6. Compose genre without messenger/docs → notepad
  const contactHit = extractMessagingContact(raw, t);
  const writeToPerson = !!contactHit && !RE_MAIL.test(t);
  if (
    !RE_MESSENGER.test(t) &&
    !writeToPerson &&
    !/(git\s|коммит|commit|репозитор|npm|node\.?js|http\s*endpoint|терминал|shell|powershell|cmd\.exe)/i.test(t) &&
    // Software objects beat genre: «создай скрипт/проект/сервер» is never a
    // notepad note, even if the request also contains the word «список».
    !RE_SOFTWARE_OBJECT.test(t) &&
    !/\.(py|js|ts|html|css|json|cs|java|go|rs)\b/i.test(t) &&
    !/(папк\w*|каталог\w*|директори\w*|[a-z]:\\|\/home\/|\/users\/)/i.test(t) &&
    /(напиши|сочини|создай|запиши).{0,80}/i.test(t) &&
    RE_GENRE_ANY.test(t)
  ) {
    return intent(
      "desktop",
      "desktop",
      true,
      "one_shot",
      86,
      "compose genre text (local)",
      {
        composeDoc: "1",
        query: raw.slice(0, 160),
        noteGenre: detectNoteGenre(t),
      },
      "notepad.compose",
    );
  }

  // Resolve the requested action before the named channel. A Telegram/Discord
  // mention is an implementation detail when the user asks to build a bot,
  // service or app. Only explicit send/reply verbs remain messaging intents.
  if (RE_BUILD_VERB.test(t) && RE_SOFTWARE_OBJECT.test(t)) {
    return intent("coder", "coder", false, "one_shot", 96, "build software", {}, "coder");
  }

  // 7. Messaging
  const conversationVerb =
    /(общайся|пообща(?:йся)?|поговори|поболт(?:ай)?|чат(?:иться)?|talk|chat)/i.test(t);
  const chatUntil =
    /(общайся|пообща|поговори|поболт|чат(?:иться)?|talk|chat).{0,40}(до|until|пока\s+не)/i.test(
      t,
    ) ||
    /(до\s+прощания|до\s+свидания|until\s+goodbye)/i.test(t) ||
    (conversationVerb && (RE_MESSENGER.test(t) || Boolean(contactHit)));
  const namesMessenger = RE_MESSENGER.test(t);
  // Code-edit verbs route to the coding agent even when they look like
  // «напиши …» to a person-shaped word («объясни как работает функция»).
  const codeEditVerb =
    (/(исправь|поправь|почини|отрефактори|оптимизируй|обнови|доработай|прогони|запусти|выполни|fix|refactor|optimize|update|run)/i.test(t) &&
      /(код|файл|функци|класс|модуль|тест|баг|ошибк|билд|сборк|code|file|function|class|module|test|bug|build)/i.test(t)) ||
    (/(напиши|написать|создай|сделай|добавь|реализуй|write|create|add|implement)/i.test(t) &&
      /(скрипт|функци|класс|модуль|endpoint|эндпоинт|\bapi\b|\bcli\b|парсер|плагин|бот\b|бота|сервис|сервер|\bcode\b|\bfunction\b)/i.test(t));
  if (namesMessenger || chatUntil || (writeToPerson && !codeEditVerb)) {
    const endPhrase =
      (t.includes("до свидания") && "до свидания") ||
      (t.includes("прощания") && "прощания") ||
      (/\bgoodbye\b/.test(t) && "goodbye") ||
      "до свидания";
    const kind: MissionKind = chatUntil ? "chat_until" : "one_shot";
    return intent(
      "messaging",
      "messaging",
      true,
      kind,
      90,
      "messaging channel",
      {
        contact: normalizeContact(contactHit || ""),
        endPhrase,
        channel: "telegram",
      },
      kind === "chat_until" ? "telegram_conversation" : "telegram_one_shot",
    );
  }

  // 8. YouTube (never docs/site/essay)
  const yt = detectYoutubeSignal(raw, t);
  if (yt) {
    return intent(
      "browser",
      "browser",
      true,
      "browser_tour",
      87,
      "youtube open",
      {
        browser: browserPref,
        query: yt.query,
        ytQuery: yt.query,
        ytMode: yt.mode,
      },
      "youtube.open.lesson",
    );
  }

  // 9. Open site / open content in browser (not YT, not notepad)
  if (
    RE_OPEN_VERB.test(t) &&
    !namesMessenger &&
    !RE_MAIL.test(t) &&
    !/(?:напиши|ответь|отправь|скажи)\s+[A-Za-zА-Яа-яЁё]{2,}/i.test(t)
  ) {
    const query = raw
      .replace(/^(открой|открыть|покажи|включи|найди|поищи)\s+(мне\s+)?/i, "")
      .trim()
      .slice(0, 160);
    return intent(
      "browser",
      "browser",
      true,
      "browser_tour",
      85,
      "open content in browser",
      { browser: browserPref, query },
      "llm_loop",
    );
  }

  // 10. Mail
  if (RE_MAIL.test(t)) {
    return intent(
      "mail",
      "messaging",
      true,
      "one_shot",
      85,
      "explicit mail context",
      { channel: "mail" },
      "gmail",
    );
  }

  // 11. System
  if (RE_SYSTEM.test(t)) {
    if (/(очист(и|ь)|опустош|выброс|empty).{0,20}(корзин|trash|recycle)/i.test(t)) {
      return intent(
        "system",
        "system",
        false,
        "system",
        80,
        "empty recycle bin",
        {},
        "system.empty_recycle_bin",
      );
    }
    return intent(
      "system",
      "system",
      false,
      "system",
      80,
      "system control intent",
      {},
      "system.control",
    );
  }

  // Building software is a coding task even if the request mentions HTML or
  // says not to use a browser. Route it before the broad browser keyword rule.
  if (/(создай|сделай|напиши|собери|билд|построй|build|create).{0,100}(калькулятор|приложен|проект|игр[уы]|веб.?сайт|html|javascript|python|скрипт|программу|\bapp\b|\btodo\b|\btodo[\s-]*app\b|\bwebsite\b|\bweb\s*app\b)/i.test(t)) {
    return intent("coder", "coder", false, "one_shot", 78, "build software", {}, "coder");
  }

  // Explicit software/code artifacts: «напиши скрипт», «сделай функцию парсинга»,
  // «create a CLI». Generic «напиши текст/список» stays with notepad compose.
  if (
    /(напиши|написать|сделай|создай|добавь|реализуй|обнови).{0,80}(скрипт|функци|класс|модуль|endpoint|эндпоинт|\bapi\b|\bcli\b|парсер|плагин|бот\b|бота|сервис|сервер|тесты?\s+(на|для|к)\b|unit[\s-]?тест)/i.test(t) ||
    /(скрипт|программ\w*)\s+(?:для|котор\w*|чтобы)\s/i.test(t) ||
    /\.(py|js|ts|tsx|jsx|html|css|json|cs|java|go|rs|sh|ps1|sql)\b/i.test(t) &&
      /(напиши|создай|добавь|измени|исправь|поправь|обнови|удали|прочитай|объясни|разбери|write|create|add|change|fix|update|remove|read|explain|refactor)/i.test(t)
  ) {
    return intent("coder", "coder", false, "one_shot", 72, "software artifact", {}, "coder");
  }

  // 12. Browser keywords
  if (
    /(ютуб|youtube|браузер|browser|открой\s+(сайт|страниц)|википед|wikipedia|reddit|github\.com|вкладк)/i.test(
      t,
    )
  ) {
    return intent(
      "browser",
      "browser",
      true,
      "browser_tour",
      75,
      "browser intent",
      { browser: browserPref },
      "llm_loop",
    );
  }

  // 13. Research
  if (/(исследуй|research|найди\s+информац|сделай\s+отч[её]т|проанализируй\s+(сайт|страниц))/i.test(t)) {
    return intent(
      "research",
      "research",
      false,
      "research",
      70,
      "research intent",
      { query: raw.slice(0, 160), reportPdf: "1" },
      "research.digest",
    );
  }

  // 14. Coder
  if (
    /(git\s|коммит|commit|репозитор|поправь\s+код|напиши\s+тест|refactor)/i.test(t) ||
    /(исправь|поправь|почини|отрефактори|оптимизируй|обнови|доработай|fix|refactor|optimize|update).{0,60}(код|файл|функци|класс|модуль|тест|баг|ошибк|билд|сборк|code|file|function|class|module|test|bug|build)/i.test(t) ||
    /(запусти|прогони|выполни).{0,40}(тесты?|билд|сборку|tests?|build|linter)/i.test(t) ||
    /(дебаг|debug|отлад\w*)\s/i.test(t) ||
    /(code\s*review|ревью\s+кода|разбер\w*\s+код|объясни\s+(?:код|функцию|как\s+работает))/i.test(t)
  ) {
    return intent("coder", "coder", false, "one_shot", 65, "coder intent", {}, "coder");
  }

  // 15. Desktop UI
  if (/(кликни|нажми|наведи|курсор|экран|скрин|открой\s+приложен)/i.test(t)) {
    return intent("desktop", "desktop", true, "one_shot", 60, "desktop UI intent", {}, "desktop");
  }

  return intent(
    "general",
    "general",
    false,
    "one_shot",
    10,
    "fallback LLM tool-loop",
    {},
    "llm_loop",
  );
}

function intent(
  domain: Domain,
  agent: AgentKind,
  requiresUi: boolean,
  missionKind: MissionKind,
  priority: number,
  reason: string,
  slots: Record<string, string>,
  harness: OrchHarnessHint,
): ClassifiedIntent {
  return {
    domain,
    agent,
    requiresUi,
    missionKind,
    priority,
    reason,
    slots: { ...slots, harness },
    harness,
  };
}

export function isGoogleDocsTask(t: string): boolean {
  if (RE_DOCS_WEB.test(t)) return true;
  if (
    /(реферат|эссе|сочинен|доклад|стать[юя]|рассказ).{0,60}(документ|docs?|браузер)/i.test(t) ||
    /(в|на)\s+(google\s*)?(docs?|документах?)/i.test(t)
  ) {
    return !RE_MESSENGER.test(t);
  }
  return false;
}

function detectNoteGenre(t: string): string {
  if (/(рассказ|истори[яи]|сказк\w*|story|tale)/i.test(t)) return "story";
  if (/(стишок|стих\w*|поэм\w*|рифм\w*|poem|rhyme|verse)/i.test(t)) return "poem";
  if (/(список|\blist\b|\btodo\b)/i.test(t)) return "list";
  if (/(письм\w*|\bletter\b)/i.test(t) && !RE_MAIL.test(t)) return "letter";
  if (RE_GENRE_ESSAY.test(t)) return "note";
  return "note";
}

function detectCronSignal(
  raw: string,
  lower: string,
): { name: string; prompt: string; everyMinutes: number } | null {
  if (!/(напоминан|кажд|каждые|cron|расписан|раз в)/i.test(lower)) return null;
  let everyMinutes: number | null = null;
  const everyM = lower.match(/каждые?\s+(\d+)\s*(минут|мин|час|часа|часов|день|дня|дней)/i);
  if (everyM) {
    const n = Number(everyM[1]);
    const unit = everyM[2];
    if (/час/.test(unit)) everyMinutes = n * 60;
    else if (/день|дня|дней/.test(unit)) everyMinutes = n * 60 * 24;
    else everyMinutes = n;
  } else if (/каждый\s+день|ежедневн/i.test(lower)) everyMinutes = 60 * 24;
  else if (/каждый\s+час/i.test(lower)) everyMinutes = 60;
  if (everyMinutes == null) return null;

  let prompt = raw
    .replace(/^(пожалуйста|плиз)[,!\s]*/i, "")
    .replace(
      /напоминан?\w*\s+(мне\s+)?(каждый\s+день\s+)?((в|во)\s+\d{1,2}(?::\d{2})?\s+)?/i,
      "",
    )
    .replace(/каждые?\s+\d+\s*(минут\w*|мин|час\w*|день|дня|дней)\s*/i, "")
    .replace(/^(чтобы\s+|и\s+)/i, "")
    .trim();
  if (prompt.length < 3) prompt = raw.replace(/напоминан?\w*/i, "").trim() || raw;
  return {
    name: (`reminder_${prompt}`).slice(0, 40).replace(/\s+/g, "_"),
    prompt,
    everyMinutes: Math.max(1, Math.min(everyMinutes, 60 * 24 * 7)),
  };
}

/** «скачай/установи программу …» — not notepad note about downloading. */
function isAppInstallTask(t: string): boolean {
  // Avoid \\b after Cyrillic — JS word boundaries are ASCII-only.
  const verb =
    /(скача(й|ть)|загруз(и|ить)|download|установ(и|ить)|install)(?:\s|$|[.,!?…])/i.test(t) ||
    /(^|\s)winget(\s|$)/i.test(t);
  if (!verb) return false;
  // Media / docs downloads stay elsewhere
  if (
    /(видео|ролик|фильм|музык|песн|torrent|реферат|эссе|доклад|pdf|файл\s+с\s+http)/i.test(t) &&
    !/(программ|приложен|installer|установщик|soft\w*|notepad\+\+)/i.test(t)
  ) {
    return false;
  }
  if (/(программ|приложен|installer|установщик|soft\w*|через\s+winget|(^|\s)winget(\s|$))/i.test(t)) {
    return true;
  }
  // notepad++: never use \\b after '+' (non-word) — it fails at EOL
  if (/notepad\+\+/i.test(t)) return true;
  if (
    /(^|[\s,])(visual\s*studio\s*code|vs\s*code|vscode|google\s*chrome|chrome|firefox|discord|7-?zip|obs(?:\s*studio)?|steam|git|nodejs|node\.js)(?:\s|$|[.,!?…])/i.test(
      t,
    )
  ) {
    return true;
  }
  // «скачай vlc» / «скачай мне spotify» — short ASCII product name left after fluff
  const rest = t
    .replace(
      /(скача(й|ть)|загруз(и|ить)|download|установ(и|ить)|install|мне|нам|пожалуйста|программу|программа|программы|приложен\w*)/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (
    rest.length >= 2 &&
    rest.length <= 40 &&
    /[a-z0-9]/i.test(rest) &&
    !/[а-яё]{4,}/i.test(rest)
  ) {
    return true;
  }
  return false;
}

function detectQuiz(
  raw: string,
  t: string,
): { tabQuery: string; bare: boolean } | null {
  const quizOrOpenTab =
    /(я\s+.{0,60}открыл|уже\s+открыт|на\s+(этой\s+)?вкладк|перейди\s+на\s+вкладк)/i.test(t) ||
    /(пройд\w*|реши|заполни|продолж\w*).{0,40}(тест|опрос|квиз|quiz|exam)/i.test(t) ||
    /(тест|опрос|квиз|quiz).{0,40}(пройд\w*|реши|заполни|продолж\w*|ответ)/i.test(t) ||
    /пройд\w*\s*(заново|до\s*конца|ещ[её])/i.test(t) ||
    /(ответ\w*|отвеч\w*).{0,40}(вопрос|тест|опрос|квиз|вариант)/i.test(t) ||
    /(вопрос|тест|опрос|квиз).{0,40}(ответ\w*|отвеч\w*|пройд\w*)/i.test(t) ||
    isBareQuizContinue(raw, t);
  if (!quizOrOpenTab) return null;

  const topic =
    raw.match(/(тест\s+по\s+[A-Za-zА-Яа-яЁё0-9\-\s]{2,40})/i)?.[1] ??
    raw.match(/((?:тест|опрос|квиз)\s+[A-Za-zА-Яа-яЁё0-9\-\s]{2,40})/i)?.[1] ??
    raw
      .replace(/\bв\s+(?:яндекс\s*)?(?:браузер\w*|chrome|edge|хром\w*)\b/gi, " ")
      .replace(/\bкоторый\s+я\s+открыл\w*\b/gi, " ")
      .match(/(?:пройд\w*|реши|заполни|продолж\w*)\s+(.+)/i)?.[1] ??
    "тест";
  return { tabQuery: topic.trim().slice(0, 120), bare: isBareQuizContinue(raw, t) };
}

function isBareQuizContinue(raw: string, t: string): boolean {
  const clean = raw
    .trim()
    .replace(/[!?….]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /^(пройди|пройти|пройдем|продолжи|продолжай|продолжить|дальше|давай|заново|решай|отвечай|ответь|так ответь|еще раз|ещё раз)(?:\s+пожалуйста)?$/i.test(
      clean,
    )
  ) {
    return true;
  }
  if (
    /^(пройди|пройти|продолж\w*|реши)\s+(его|ее|их|этот|тот|заново|еще\s*раз|ещё\s*раз|до\s*конца)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/так\s+ответь/i.test(t)) return true;
  if (/пройд\w*.{0,30}заново/i.test(t)) return true;
  if (/^(давай|продолжай|работай)[!?.…]*$/i.test(raw.trim())) return true;
  return false;
}

function detectYoutubeSignal(
  raw: string,
  t: string,
): { query: string; mode: "quick" | "deep" } | null {
  if (isNonYoutubeOpenTask(t)) return null;
  const mentionsYoutube = /ютуб|youtube|youtu\.be/i.test(t);
  const mentionsMedia = RE_MEDIA_YT.test(t);
  const openMediaShortcut =
    RE_OPEN_VERB.test(t) &&
    mentionsMedia &&
    !/(телеграм|telegram|блокнот|notepad|файл|папк|настройк|почт|gmail)/i.test(t);

  if (
    !mentionsYoutube &&
    !mentionsMedia &&
    !openMediaShortcut &&
    !/(открой|найди|включи|покажи).{0,40}(python|пайтон|джава|react).{0,20}(урок|видео|tutorial|курс)/i.test(
      t,
    )
  ) {
    return null;
  }

  const wantsOpen =
    /(открой|найди|включи|покажи|поиск|поищи|запусти|play|open|find|search|watch)/i.test(t) ||
    /(урок|видео|ролик|выпуск|tutorial|lesson).{0,40}(по|про|about|on)/i.test(t);
  if (!wantsOpen && !mentionsYoutube) return null;

  let query =
    raw.match(
      /(?:открой|найди|включи|покажи|поищи)\s+(?:мне\s+)?(?:на\s+)?(?:ютуб[еа]?|youtube)\s+(.+)$/i,
    )?.[1] ??
    raw.match(/(?:открой|найди|включи|покажи)\s+(?:мне\s+)?(.+?)(?:\s+на\s+(?:ютуб|youtube))/i)?.[1] ??
    raw.match(/(?:урок|видео|ролик|tutorial|lesson).{0,40}(?:по|про|about|on)\s+(.+)$/i)?.[1] ??
    null;

  if (!query && (mentionsMedia || mentionsYoutube)) {
    query = raw
      .replace(/^(открой|открыть|покажи|включи|найди|поищи)\s+(мне\s+)?/i, "")
      .replace(/\s+на\s+(ютуб[еа]?|youtube)\s*$/i, "")
      .trim();
  }
  if (!query || query.length < 2) return null;
  query = query.replace(/[?!.,]+$/g, "").trim().slice(0, 140);

  const deep =
    /(урок|tutorial|lesson|курс|обуч|разбер|объясн)/i.test(t) ||
    /(урок|tutorial|lesson).{0,20}(по|про)/i.test(t);
  return { query, mode: deep ? "deep" : "quick" };
}

function isNonYoutubeOpenTask(t: string): boolean {
  return (
    RE_DOCS_WEB.test(t) ||
    RE_SITE.test(t) ||
    RE_NOTEPAD.test(t) ||
    /(документ\w*|реферат|презентац|таблиц|sheet|slides|figma|canva|gmail|почт|настройк)/i.test(
      t,
    ) ||
    /(напиши|написать|сочини).{0,40}(реферат|текст|стать|эссе|доклад)/i.test(t)
  );
}

/** Real person after «напиши/ответь», not genre / quiz / open-content. */
export function extractMessagingContact(raw: string, t: string): string {
  if (/(?:не\s+используй|без)\s+инструмент|do not use tools|without tools/i.test(t)) return "";
  // A formatting instruction ("reply exactly OK") is never a person's name.
  // Sending it to Telegram is a dangerous false positive.
  if (/(?:ответь|скажи|напиши)\s+(?:одним\s+словом|кратко|коротко|подробно|только|дословно|ровно|точно|exactly|briefly)/i.test(t) && !RE_MESSENGER.test(t)) return "";
  if (/(тест|опрос|квиз|quiz|вопрос\w*|вариант\w*|exam)/i.test(t)) return "";
  if (isGoogleDocsTask(t)) return "";
  if (RE_OPEN_VERB.test(t) && !RE_MESSENGER.test(t)) return "";

  const messengerTarget = raw.match(
    /(?:напиши|написать|ответь|ответить|скажи|отправь|message)\s+(?:в\s+)?(?:телеграм|telegram|тг|whats\s?app|вотсап|ватсап|вайбер|viber|discord|дискорд)\s+([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё-]{1,40})/i,
  );
  const afterWrite = raw.match(
    /(?:напиши|написать|ответь|ответить|скажи|отправь|message)\s+(?:(?:мне|нам)\s+)?([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё-]{1,40})/i,
  );
  const m =
    messengerTarget ??
    afterWrite ??
    raw.match(
      /(?:пообщайся|поговори|chat\s+with|talk\s+to)\s+(?:с\s+|со\s+|with\s+)?([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё-]{1,40})/i,
    ) ??
    raw.match(
      /(?:общайся|пообщайся)\s+(?:с\s+|со\s+)?([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё-]{1,40})/i,
    );

  if (!m?.[1]) return "";
  const word = m[1];
  if (CONTACT_STOP.test(word)) return "";
  if (RE_GENRE_ANY.test(word)) return "";
  return word;
}

function normalizeContact(raw: string): string {
  if (!raw) return "";
  let c = raw.trim();
  if (/^(ним|ней|нём|ему|ей|его|её|them|him|her)$/i.test(c)) return "";
  const kinship: Record<string, string> = {
    маме: "Мама",
    маму: "Мама",
    мама: "Мама",
    папе: "Папа",
    папу: "Папа",
    папа: "Папа",
    сестре: "Сестра",
    сестру: "Сестра",
    брату: "Брат",
  };
  const known = kinship[c.toLocaleLowerCase("ru-RU")];
  if (known) return known;
  c = c.replace(/(ом|у|ой)$/i, "");
  if (!c || c.length < 2) return "";
  return c.charAt(0).toUpperCase() + c.slice(1);
}
