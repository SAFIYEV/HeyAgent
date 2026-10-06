import { test } from "node:test";
import assert from "node:assert/strict";
import { routeTask } from "./router.js";
import { buildPlan } from "./planner.js";
import { MissionQueue } from "./queue.js";
import { verify, looksLikeSearchBarPollution } from "./verifier.js";
import { dispatchAgent } from "./agents/dispatch.js";
import { IdempotencyGuard } from "./idempotency.js";
import { generateId } from "@heyagent/shared";
import type { Mission } from "./types.js";

test("format-only reply instructions never become a messaging contact", () => {
  for (const text of ["Ответь одним словом: привет. Не используй инструменты.", "Ответь кратко: привет", "Скажи только привет", "Ответь ровно: OK", "Ответь exactly: OK"]) {
    assert.notEqual(routeTask(text).domain, "messaging");
  }
});

test("router: telegram reply never goes to mail", () => {
  const r = routeTask("ответь алексу в telegram");
  assert.equal(r.domain, "messaging");
  assert.notEqual(r.domain, "mail");
});

test("router: Russian stop is a terminal cancel route", () => {
  const r = routeTask("стоп");
  assert.equal(r.slots.cancel, "1");
  assert.equal(dispatchAgent(r).harness, "cancel");
  assert.deepEqual(buildPlan("стоп", r).steps.map((s) => s.kind), ["cancel"]);
});

test("router: explicit mail still routes to mail", () => {
  const r = routeTask("открой почту gmail");
  assert.equal(r.domain, "mail");
});

test("router: building a Telegram bot uses coding tools", () => {
  const r = routeTask("Создай мне телеграм бота, который будет напоминать об уроках за 10 минут. Составь график и бота");
  assert.equal(r.domain, "coder");
  assert.equal(dispatchAgent(r).harness, "coder");
});

test("router: software action wins over channel wording", () => {
  for (const request of [
    "Сделай Discord бота для напоминаний",
    "Разработай Telegram сервис расписания уроков",
    "Создай приложение с интеграцией Telegram",
    "Сделай Vue панель администратора",
  ]) {
    const r = routeTask(request);
    assert.equal(r.domain, "coder", request);
    assert.equal(dispatchAgent(r).harness, "coder", request);
  }
  for (const request of [
    "Напиши сообщение в Telegram",
    "Отправь ответ в Discord",
  ]) {
    assert.equal(routeTask(request).domain, "messaging", request);
  }
});

test("router: creating a calculator in a project uses coding tools", () => {
  for (const request of [
    "создай мне калькулятор",
    "создай мне todo app",
    "создай мне todoapp",
    "Создай рабочий калькулятор в выбранной папке: HTML, CSS и JavaScript. Не используй браузер.",
  ]) {
    const route = routeTask(request);
    assert.equal(route.domain, "coder", request);
    assert.equal(dispatchAgent(route).harness, "coder", request);
  }
});

test("router: latest news without an explicit PDF still uses the digest harness", () => {
  for (const q of [
    "последние новости Азербайджана",
    "собери мне последние новости Азербайджана",
    "собери мне например последние новости Азербайджана",
  ]) {
    const r = routeTask(q);
    assert.equal(r.slots.harness, "research.digest", q);
    assert.equal(dispatchAgent(r).harness, "research.digest", q);
  }
});

test("router: chat-until extracts contact not pronoun", () => {
  const r = routeTask("напиши алексу и общайся с ним до прощания");
  assert.equal(r.missionKind, "chat_until");
  assert.match(r.slots.contact.toLowerCase(), /алекс/);
});

test("planner: chat_until has wait before next send", () => {
  const route = routeTask("напиши алексу и общайся до прощания");
  const plan = buildPlan("chat", route);
  const kinds = plan.steps.map((s) => s.kind);
  assert.ok(kinds.includes("open_chat"));
  assert.ok(kinds.includes("click_composer"));
  assert.ok(kinds.includes("send_message_once"));
  assert.ok(kinds.includes("wait_for_reply"));
  const sendIdx = kinds.indexOf("send_message_once");
  const waitIdx = kinds.indexOf("wait_for_reply");
  assert.ok(waitIdx > sendIdx, "must wait AFTER send, never spam");
});

test("queue: only one UI mission runs at a time", () => {
  const q = new MissionQueue();
  const mk = (id: string, ui: boolean): Mission => ({
    id,
    kind: "one_shot",
    domain: "messaging",
    agent: "messaging",
    status: "queued",
    goal: id,
    plan: {
      id: generateId("plan"),
      goal: id,
      domain: "messaging",
      agent: "messaging",
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    requiresUi: ui,
    checkpoint: { planStepIndex: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  q.enqueue(mk("a", true));
  q.enqueue(mk("b", true));
  q.enqueue(mk("c", false));
  const first = q.dequeueRunnable();
  assert.equal(first?.id, "a");
  const second = q.dequeueRunnable();
  // non-UI can run alongside
  assert.equal(second?.id, "c");
  assert.equal(q.dequeueRunnable(), null, "second UI must wait");
  q.update("a", { status: "done" });
  assert.equal(q.dequeueRunnable()?.id, "b");
});

test("verifier: search bar pollution is a FAIL", () => {
  assert.equal(
    looksLikeSearchBarPollution("АлексПривет, Алекс! Как дела", "Привет, Алекс! Как дела"),
    true,
  );
  const v = verify({
    name: "composer_focused",
    searchBarLooksLikeMessage: true,
  });
  assert.equal(v.verdict, "fail");
});

test("verifier: reply_received requires lastSeenReply", () => {
  assert.equal(verify({ name: "reply_received" }).verdict, "fail");
  assert.equal(verify({ name: "reply_received", lastSeenReply: "ок" }).verdict, "pass");
});

test("verifier: tool_ok requires non-error evidence", () => {
  assert.equal(verify({ name: "tool_ok" }).verdict, "unknown");
  assert.equal(verify({ name: "tool_ok", evidence: "ERROR: no browser" }).verdict, "fail");
  assert.equal(verify({ name: "tool_ok", evidence: "Opened C:/report.pdf" }).verdict, "pass");
});

test("dispatch: chat_until → telegram_conversation harness", () => {
  const d = dispatchAgent(routeTask("общайся с алексом до прощания"));
  assert.equal(d.harness, "telegram_conversation");
});

test("router+dispatch: already-open test → open_tab harness", () => {
  const r = routeTask("я в Яндексе открыл тест по математике пройди его");
  assert.equal(r.domain, "browser");
  assert.equal(r.slots.openTab, "1");
  assert.equal(r.slots.browser, "yandex");
  assert.match(r.slots.tabQuery || "", /тест|матем/i);
  assert.doesNotMatch(r.slots.tabQuery || "", /яндекс браузер/i);
  const d = dispatchAgent(r);
  assert.equal(d.harness, "open_tab");
});

test("router: Пройди!!!! → open_tab continue (not llm_loop)", () => {
  const r = routeTask("Пройди!!!!");
  assert.equal(r.domain, "browser");
  assert.equal(r.slots.openTab, "1");
  assert.equal(r.slots.quizContinue, "1");
  assert.equal(dispatchAgent(r).harness, "open_tab");
});

test("router: Так ответь → open_tab continue", () => {
  const r = routeTask("Так ответь");
  assert.equal(r.slots.openTab, "1");
  assert.equal(dispatchAgent(r).harness, "open_tab");
});

test("router: ответь на вопросы теста → browser NOT telegram", () => {
  const r = routeTask("Ответь на вопросы теста по математике");
  assert.equal(r.domain, "browser");
  assert.equal(r.slots.openTab, "1");
  assert.equal(dispatchAgent(r).harness, "open_tab");
});

test("router: ответь на вопрос → browser not telegram", () => {
  const r = routeTask("ответь на вопрос");
  assert.equal(r.domain, "browser");
  assert.equal(dispatchAgent(r).harness, "open_tab");
});

test("router: ответь алексу still messaging", () => {
  const r = routeTask("ответь алексу что все ок");
  assert.equal(r.domain, "messaging");
  assert.match(r.slots.contact || "", /алекс/i);
});

test("router: открой дым сигарет с ментолом → browser NOT telegram Menthol", () => {
  const r = routeTask("открой мне дым сигарет с ментолом");
  assert.equal(r.domain, "browser");
  assert.notEqual(r.slots.contact, "Ментол");
  assert.equal(dispatchAgent(r).harness, "youtube.open.lesson");
});

test("router: реферат в google docs → browser, not Telegram Реферат", () => {
  const r = routeTask("напиши мне реферат в google docs по теме криптография");
  assert.equal(r.domain, "browser");
  assert.equal(r.slots.googleDocs, "1");
  assert.equal(r.slots.contact || "", "");
  assert.equal(r.requiresUi, false);
  assert.equal(dispatchAgent(r).harness, "docs.compose");
});

test("router: напиши реферат alone is not messaging contact", () => {
  const r = routeTask("напиши реферат по криптографии");
  assert.notEqual(r.domain, "messaging");
  assert.equal(r.slots.composeDoc, "1");
  assert.equal(r.slots.harness, "notepad.compose");
  assert.equal(r.slots.contact || "", "");
});

test("router: Git workflow with README text uses coder, not notepad", () => {
  const r = routeTask(
    "Создай Git-репозиторий во временной директории, добавь README.md с текстом HeyAgent audit, сделай первый commit",
  );
  assert.equal(r.domain, "coder");
  assert.notEqual(r.slots.harness, "notepad.compose");
  assert.equal(dispatchAgent(r).harness, "coder");
});

test("router: code editing / testing / debugging tasks use the coding agent", () => {
  for (const request of [
    "исправь падающий тест в модуле auth",
    "fix the failing build",
    "поправь функцию парсинга в файле parser.ts",
    "напиши скрипт для бэкапа базы",
    "добавь endpoint /health в сервер",
    "запусти тесты",
    "прогони билд",
    "проведи code review",
    "объясни как работает функция retry",
  ]) {
    const route = routeTask(request);
    assert.equal(route.domain, "coder", request);
    assert.equal(dispatchAgent(route).harness, "coder", request);
  }
});

test("router: generic notes and lists still stay out of coding", () => {
  for (const request of ["напиши список покупок", "напиши рассказ про кота"]) {
    assert.notEqual(routeTask(request).domain, "coder", request);
  }
});

test("router: открой блокнот → desktop notepad, not browser", () => {
  const r = routeTask("открой блокнот");
  assert.equal(r.domain, "desktop");
  assert.equal(r.slots.harness, "notepad.compose");
  assert.equal(dispatchAgent(r).harness, "notepad.compose");
});

test("router: скачай notepad++ → app.install, not notepad.compose", () => {
  for (const q of ["скачай мне notepad++", "скачай мне программу notepad++", "скачай notepad++"]) {
    const r = routeTask(q);
    assert.equal(r.domain, "desktop", q);
    assert.equal(r.slots.harness, "app.install", q);
    assert.equal(r.slots.appInstall, "1", q);
    assert.equal(dispatchAgent(r).harness, "app.install", q);
  }
});

test("router: открой notepad (без ++) still compose", () => {
  const r = routeTask("открой notepad");
  assert.equal(r.slots.harness, "notepad.compose");
});

test("router: скажи правду ≠ messaging", () => {
  const r = routeTask("скажи правду");
  assert.notEqual(r.domain, "messaging");
  assert.equal(r.slots.contact || "", "");
});

test("router: google docs harness hint is docs.compose", () => {
  const r = routeTask("напиши мне реферат в google docs по теме криптография");
  assert.equal(r.slots.harness, "docs.compose");
  assert.equal(dispatchAgent(r).harness, "docs.compose");
});

test("router: поговори с алексом still messaging", () => {
  const r = routeTask("поговори с алексом");
  assert.equal(r.domain, "messaging");
  assert.match(r.slots.contact || "", /алекс/i);
});

test("router: Telegram mom greeting + conversation keeps contact and chat-until", () => {
  const r = routeTask("напиши в телеграм маме привет и поговори с ней");
  assert.equal(r.domain, "messaging");
  assert.equal(r.missionKind, "chat_until");
  assert.equal(r.slots.contact, "Мама");
  assert.equal(dispatchAgent(r).harness, "telegram_conversation");
});

test("router: heartbeat checklist examples never trigger a digest", () => {
  const q = [
    "[SYSTEM HEARTBEAT] Periodic autonomy check.",
    "1. Any due cron?",
    "2. If the owner asked for regular news digests — run research.digest.",
    "Otherwise reply HEARTBEAT_OK.",
  ].join("\n");
  const r = routeTask(q);
  assert.equal(r.slots.harness, "llm_loop");
  assert.equal(r.slots.systemHeartbeat, "1");
  assert.equal(dispatchAgent(r).harness, "llm_loop");
});

test("router: пройди тест … в яндекс браузере → query is test topic", () => {
  const r = routeTask("пройти тест по математике который я открыл в яндекс браузере");
  assert.equal(r.slots.openTab, "1");
  assert.match(r.slots.tabQuery || "", /тест.*матем|матем/i);
  assert.doesNotMatch(r.slots.tabQuery || "", /^в яндекс/i);
});

test("idempotency: blocks duplicate send within window", () => {
  const g = new IdempotencyGuard();
  assert.equal(g.canSend("Алекс", "привет"), true);
  g.recordSend("Алекс", "привет");
  assert.equal(g.canSend("Алекс", "привет"), false);
  assert.equal(g.canSend("Алекс", "как дела"), true);
});
