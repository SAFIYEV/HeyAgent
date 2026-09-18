const GATEWAY = "http://127.0.0.1:28789";
const LOCALE_KEY = "heyagent.locale";
let productLocale = "ru";
let gatewayStatus = null;
let sessionId = null;
let selectedAvatar = "sprite-04";
let currentAvatar = "sprite-04";
let avatarState = "idle";
let avatarFrame = 0;

const UI_TEXT = {
  en: {
    connecting: "Connecting…",
    online: "Online",
    offline: "Offline",
    gatewayOffline: "Gateway offline — run: hey gateway start",
    firstLaunch: "FIRST LAUNCH",
    onboardTitle: "Name your agent",
    onboardCopy:
      "Create your personal assistant — you can change these settings later.",
    agentName: "Agent name",
    avatarTitle: "Pick an avatar",
    continue: "Continue",
    readyTitle: "Ready when you are",
    readyCopy: "Ask anything or delegate a task.",
    chatPlaceholder: "Ask anything…",
    send: "Send",
    chat: "Chat",
    automation: "AUTOMATION",
    missions: "Missions",
    refresh: "Refresh",
    pause: "Pause",
    cancelAll: "Cancel all",
    queue: "Queue",
    history: "History",
    safePreview: "Safe preview",
    intelligence: "INTELLIGENCE",
    models: "Models",
    configureTerminal: "Configure from the terminal:",
    testConnection: "Test connection",
    workspace: "WORKSPACE",
    services: "Services",
    connect: "Connect",
    connectCopy:
      "Connect Google Workspace, Notion and other services from the terminal.",
    run: "Run:",
    or: "or",
    enterName: "Enter a name",
    terminalSetup: "Run in terminal to complete setup",
    name: "Name",
    avatar: "Avatar",
    model: "Model",
    activeUi: "Active UI",
    pendingApprovals: "Pending approvals",
    cron: "Cron",
    none: "none",
    queueEmpty: "Queue empty",
    noHistory: "No history yet",
    defaultModel: "Default",
    fallbacks: "Fallbacks",
    providers: "Providers",
    error: "Error",
    approve: "Approve",
    deny: "Deny",
  },
  ru: {
    connecting: "Подключение…",
    online: "В сети",
    offline: "Не в сети",
    gatewayOffline: "Шлюз не запущен — выполните: hey gateway start",
    firstLaunch: "ПЕРВЫЙ ЗАПУСК",
    onboardTitle: "Назовите агента",
    onboardCopy:
      "Создайте персонального помощника — настройки можно изменить позже.",
    agentName: "Имя агента",
    avatarTitle: "Выберите аватар",
    continue: "Продолжить",
    readyTitle: "Готов к работе",
    readyCopy: "Спросите что угодно или поручите задачу.",
    chatPlaceholder: "Напишите запрос…",
    send: "Отправить",
    chat: "Чат",
    automation: "АВТОМАТИЗАЦИЯ",
    missions: "Задачи",
    refresh: "Обновить",
    pause: "Пауза",
    cancelAll: "Отменить все",
    queue: "Очередь",
    history: "История",
    safePreview: "Безопасное подтверждение",
    intelligence: "ИНТЕЛЛЕКТ",
    models: "Модели",
    configureTerminal: "Настройте через терминал:",
    testConnection: "Проверить подключение",
    workspace: "РАБОЧЕЕ ПРОСТРАНСТВО",
    services: "Сервисы",
    connect: "Связи",
    connectCopy:
      "Подключайте Google Workspace, Notion и другие сервисы из терминала.",
    run: "Выполните:",
    or: "или",
    enterName: "Введите имя",
    terminalSetup: "Завершите настройку в терминале",
    name: "Имя",
    avatar: "Аватар",
    model: "Модель",
    activeUi: "Активный UI",
    pendingApprovals: "Ожидают подтверждения",
    cron: "Расписание",
    none: "нет",
    queueEmpty: "Очередь пуста",
    noHistory: "Истории пока нет",
    defaultModel: "По умолчанию",
    fallbacks: "Резервные",
    providers: "Провайдеры",
    error: "Ошибка",
    approve: "Разрешить",
    deny: "Отклонить",
  },
};

function t(key) {
  return (UI_TEXT[productLocale] || UI_TEXT.en)[key] || key;
}

function applyProductLocale(locale, persist = true) {
  productLocale = locale === "ru" ? "ru" : "en";
  document.documentElement.lang = productLocale;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-locale]").forEach((button) => {
    const active = button.dataset.locale === productLocale;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (persist) localStorage.setItem(LOCALE_KEY, productLocale);
  renderGatewayStatus();
  const active = document.querySelector(".tab.active")?.dataset.tab;
  if (active === "missions") void refreshMissions();
  if (active === "models") void refreshModels();
}

async function api(path, options) {
  const response = await fetch(`${GATEWAY}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || data.message || `HTTP ${response.status}`);
  return data;
}

const AVATARS = [
  { id: "sprite-01", label: "Cyan Bot", color: "#3dd9c4" },
  { id: "sprite-02", label: "Amber Scout", color: "#f5a623" },
  { id: "sprite-03", label: "Rose Pilot", color: "#e85d8a" },
  { id: "sprite-04", label: "Lime Ranger", color: "#7ed957" },
  { id: "sprite-05", label: "Indigo Sage", color: "#6b7fd7" },
  { id: "sprite-06", label: "Coral Spark", color: "#ff6b4a" },
  { id: "sprite-07", label: "Mint Ghost", color: "#9ef0d0" },
  { id: "sprite-08", label: "Gold Knight", color: "#d4a017" },
  { id: "sprite-09", label: "Violet Wisp", color: "#a855f7" },
  { id: "sprite-10", label: "Steel Core", color: "#8b9aab" },
  { id: "sprite-11", label: "Sunrise", color: "#ff9a56" },
  { id: "sprite-12", label: "Night Owl", color: "#4a5568" },
];

const SPRITES = {
  "sprite-01": [
    [0, 1, 1, 1, 1, 1, 1, 0],
    [1, 1, 3, 1, 1, 3, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 1],
    [1, 2, 2, 2, 2, 2, 2, 1],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 0, 1, 1, 0, 1, 0],
    [0, 1, 0, 1, 1, 0, 1, 0],
    [0, 2, 0, 0, 0, 0, 2, 0],
  ],
  "sprite-02": [
    [0, 0, 4, 4, 4, 4, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [1, 3, 1, 1, 1, 1, 3, 1],
    [1, 1, 1, 2, 2, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 0, 0, 0, 0, 1, 0],
    [0, 2, 0, 0, 0, 0, 2, 0],
  ],
  "sprite-03": [
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 4, 4, 4, 4, 1, 0],
    [1, 3, 1, 1, 1, 1, 3, 1],
    [1, 1, 1, 1, 1, 1, 1, 1],
    [0, 1, 2, 2, 2, 2, 1, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [2, 2, 0, 0, 0, 0, 2, 2],
  ],
  "sprite-04": [
    [0, 4, 0, 1, 1, 0, 4, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 3, 1, 1, 3, 1, 0],
    [1, 1, 1, 2, 2, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 0, 0, 0, 0, 1, 0],
    [0, 4, 0, 0, 0, 0, 4, 0],
  ],
  "sprite-05": [
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [1, 3, 4, 1, 1, 4, 3, 1],
    [1, 1, 1, 1, 1, 1, 1, 1],
    [0, 1, 2, 1, 1, 2, 1, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 0, 1, 0, 0, 1, 0, 0],
    [0, 0, 2, 0, 0, 2, 0, 0],
  ],
  "sprite-06": [
    [0, 0, 0, 4, 4, 0, 0, 0],
    [0, 4, 1, 1, 1, 1, 4, 0],
    [0, 1, 3, 1, 1, 3, 1, 0],
    [1, 1, 1, 1, 1, 1, 1, 1],
    [0, 1, 1, 2, 2, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 0, 0, 0, 0, 1, 0],
    [4, 0, 0, 0, 0, 0, 0, 4],
  ],
  "sprite-07": [
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [1, 3, 1, 1, 1, 1, 3, 1],
    [1, 1, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 1],
    [1, 1, 0, 1, 1, 0, 1, 1],
    [1, 0, 0, 1, 1, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 1],
  ],
  "sprite-08": [
    [0, 2, 2, 2, 2, 2, 2, 0],
    [2, 1, 1, 1, 1, 1, 1, 2],
    [1, 3, 1, 1, 1, 1, 3, 1],
    [1, 1, 1, 4, 4, 1, 1, 1],
    [2, 1, 1, 1, 1, 1, 1, 2],
    [0, 2, 1, 1, 1, 1, 2, 0],
    [0, 1, 0, 0, 0, 0, 1, 0],
    [0, 2, 0, 0, 0, 0, 2, 0],
  ],
  "sprite-09": [
    [0, 0, 0, 4, 0, 0, 0, 0],
    [0, 0, 1, 1, 1, 0, 0, 0],
    [0, 1, 3, 1, 3, 1, 0, 0],
    [0, 1, 1, 1, 1, 1, 0, 0],
    [0, 0, 1, 4, 1, 0, 0, 0],
    [0, 0, 0, 1, 0, 0, 4, 0],
    [0, 4, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 2, 0, 0, 0, 0],
  ],
  "sprite-10": [
    [0, 2, 1, 1, 1, 1, 2, 0],
    [2, 1, 1, 1, 1, 1, 1, 2],
    [1, 3, 2, 1, 1, 2, 3, 1],
    [1, 1, 1, 4, 4, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 1],
    [2, 1, 1, 1, 1, 1, 1, 2],
    [0, 2, 1, 0, 0, 1, 2, 0],
    [0, 0, 2, 0, 0, 2, 0, 0],
  ],
  "sprite-11": [
    [0, 4, 0, 4, 4, 0, 4, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
    [4, 1, 3, 1, 1, 3, 1, 4],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 1, 2, 2, 1, 0, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 0, 0, 0, 0, 1, 0],
    [0, 2, 0, 0, 0, 0, 2, 0],
  ],
  "sprite-12": [
    [0, 2, 0, 0, 0, 0, 2, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 3, 1, 1, 3, 1, 0],
    [1, 1, 4, 1, 1, 4, 1, 1],
    [0, 1, 1, 2, 2, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 0, 1, 0, 0, 1, 0, 0],
    [0, 0, 2, 0, 0, 2, 0, 0],
  ],
};

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function shade([r, g, b], factor) {
  return [
    Math.min(255, Math.round(r * factor)),
    Math.min(255, Math.round(g * factor)),
    Math.min(255, Math.round(b * factor)),
  ];
}

function drawSprite(canvas, avatarId, color, scale = 6, animated = false) {
  const grid = SPRITES[avatarId];
  if (!grid) return;
  const margin = animated ? scale * 2 : 0;
  canvas.width = 8 * scale + margin * 2;
  canvas.height = 8 * scale + margin * 2;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const main = hexToRgb(color);
  const palette = {
    1: main,
    2: shade(main, 0.45),
    3: [10, 13, 23],
    4: shade(main, 1.35),
  };
  const frame = avatarFrame % 4;
  const frameX =
    animated && avatarState === "working" ? (frame % 2 ? scale : -scale) : 0;
  const frameY =
    animated && avatarState === "thinking" && (frame === 1 || frame === 2)
      ? -scale
      : 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let pixel = grid[y][x];
      if (
        animated &&
        avatarState === "idle" &&
        frame === 3 &&
        y === 2 &&
        pixel === 3
      )
        pixel = 1;
      if (!pixel) continue;
      const [r, g, b] = palette[pixel];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(
        margin + x * scale + frameX,
        margin + y * scale + frameY,
        scale,
        scale,
      );
    }
  }
}

function setAvatarState(state) {
  avatarState = state;
  const canvas = document.getElementById("avatar");
  if (canvas) canvas.className = `avatar ${state}`;
}

function paintHero(avatarId) {
  currentAvatar = avatarId;
  const meta = AVATARS.find((avatar) => avatar.id === avatarId) || AVATARS[3];
  const canvas = document.getElementById("avatar");
  if (canvas?.getContext) drawSprite(canvas, meta.id, meta.color, 8, true);
}

function startAvatarAnimation() {
  window.setInterval(() => {
    avatarFrame += 1;
    paintHero(currentAvatar);
  }, 180);
}

function renderGatewayStatus() {
  const status = document.getElementById("agent-status");
  const dot = document.getElementById("status-dot");
  if (!status || !dot) return;
  dot.className = "status-dot";
  if (gatewayStatus?.ok) {
    dot.classList.add("online");
    status.textContent = t("online");
  } else if (gatewayStatus) {
    dot.classList.add("offline");
    status.textContent = t("offline");
  } else {
    dot.classList.add("offline");
    status.textContent = "Gateway не запущен";
  }
  document.getElementById("composer-model").textContent = gatewayStatus?.model
    ? `${gatewayStatus.model} ⌄`
    : "Настроить модель ⌄";
  document.getElementById("policy-label").textContent =
    {
      ask: "Подтверждения включены",
      risky: "Контроль рискованных действий",
      full: "Полный доступ",
      allowlist: "Доступ по списку",
    }[gatewayStatus?.policyMode] || "Доступы: —";
  document.getElementById("connection-detail").textContent = gatewayStatus?.ok
    ? "Gateway · 127.0.0.1:28789"
    : "Запустите: hey gateway start";
}

async function init() {
  setupWorkspace();
  setupTabs();
  setupAvatarGrid();
  setupChat();
  setupOnboard();
  setupMissions();
  setupModelsPanel();
  setupLocaleSwitch();
  paintHero(selectedAvatar);
  startAvatarAnimation();
  startApprovalPoll();

  const savedLocale = localStorage.getItem(LOCALE_KEY);
  applyProductLocale(savedLocale || "ru", false);

  try {
    const response = await fetch(`${GATEWAY}/status`);
    gatewayStatus = await response.json();
    if (!savedLocale) applyProductLocale(gatewayStatus.locale, false);
    renderGatewayStatus();
  } catch {
    gatewayStatus = null;
    renderGatewayStatus();
  }

  try {
    const response = await fetch(`${GATEWAY}/identity`);
    const data = await response.json();
    if (data.identity) {
      document.getElementById("agent-name").textContent = data.identity.name;
      paintHero(data.identity.avatarId);
      document.getElementById("onboard").classList.add("hidden");
    } else {
      showOnboarding();
    }
  } catch {
    // An offline gateway is not evidence of a missing identity.
  }
  void refreshSkills();
  void refreshIntegrations();
  window.setInterval(async () => {
    try {
      gatewayStatus = await api("/status");
    } catch {
      gatewayStatus = null;
    }
    renderGatewayStatus();
  }, 10000);
}

function setupLocaleSwitch() {
  document.querySelectorAll("[data-locale]").forEach((button) => {
    button.addEventListener("click", () =>
      applyProductLocale(button.dataset.locale),
    );
  });
}

function showOnboarding() {
  document
    .querySelectorAll(".panel")
    .forEach((panel) => panel.classList.add("hidden"));
  document.getElementById("onboard").classList.remove("hidden");
  document.getElementById("chat").classList.add("hidden");
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      showView(tab.dataset.tab);
    });
  });
}

function setupMissions() {
  document
    .getElementById("missions-refresh")
    ?.addEventListener("click", () => void refreshMissions());
  document
    .getElementById("missions-pause")
    ?.addEventListener("click", async () => {
      await api("/missions/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      void refreshMissions();
    });
  document
    .getElementById("missions-cancel")
    ?.addEventListener("click", async () => {
      await api("/missions/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      void refreshMissions();
    });
}

async function refreshMissions() {
  const statusEl = document.getElementById("missions-status");
  const queueEl = document.getElementById("missions-queue");
  const historyEl = document.getElementById("missions-history");
  if (!statusEl || !queueEl || !historyEl) return;
  try {
    const [missions, status] = await Promise.all([
      fetch(`${GATEWAY}/missions`).then((response) => response.json()),
      fetch(`${GATEWAY}/status`).then((response) => response.json()),
    ]);
    statusEl.textContent = [
      `${t("model")}: ${status.model || "?"}`,
      `${t("activeUi")}: ${missions.activeUi || t("none")}`,
      `${t("pendingApprovals")}: ${status.pendingApprovals ?? 0}`,
      "",
      `${t("cron")}:`,
      missions.cron || `(${t("none")})`,
    ].join("\n");
    renderMissionList(queueEl, missions.queue || []);
    renderList(
      historyEl,
      missions.history || [],
      t("noHistory"),
      (item) =>
        `${(item.at || "").slice(0, 16)} · ${item.harness || "?"} — ${(item.goal || "").slice(0, 70)}`,
    );
  } catch {
    statusEl.textContent = t("gatewayOffline");
  }
}

function renderMissionList(element, missions) {
  element.replaceChildren();
  if (!missions.length)
    return renderList(element, [], t("queueEmpty"), () => "");
  missions.forEach((mission) => {
    const li = document.createElement("li");
    li.className = "mission-card";
    const title = document.createElement("strong");
    title.textContent = `[${mission.status}] ${(mission.goal || "").slice(0, 100)}`;
    const meta = document.createElement("small");
    const steps = (mission.steps || []).map((step) => step.kind).join(" → ");
    meta.textContent = `${mission.harness || "llm"}${steps ? ` · ${steps}` : ""}`;
    const actions = document.createElement("div");
    actions.className = "mission-actions";
    if (!["done", "cancelled", "failed"].includes(mission.status)) {
      actions.append(
        approvalButton(t("pause"), "btn", () =>
          missionAction("pause", mission.id),
        ),
        approvalButton(t("cancelAll"), "btn danger", () =>
          missionAction("cancel", mission.id),
        ),
      );
    }
    li.append(title, meta, actions);
    element.appendChild(li);
  });
}

async function missionAction(action, id) {
  await api(`/missions/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  void refreshMissions();
}

function renderList(element, items, emptyText, format) {
  element.replaceChildren();
  const values = items.length ? items : [null];
  values.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item ? format(item) : emptyText;
    element.appendChild(li);
  });
}

function setupModelsPanel() {
  document
    .getElementById("test-model")
    ?.addEventListener("click", () => void testModel());
  document
    .getElementById("run-preflight")
    ?.addEventListener("click", () => void refreshPreflight());
}

async function testModel() {
  const element = document.getElementById("model-status");
  element.textContent = "Проверяю модель…";
  try {
    const data = await api("/models/test", { method: "POST" });
    element.textContent = `${data.ok ? "✓" : "✕"} ${data.message}`;
  } catch (error) {
    element.textContent = `${t("error")}: ${error.message}`;
  }
}

async function refreshPreflight() {
  const element = document.getElementById("preflight");
  element.textContent = "Проверяю готовность…";
  try {
    const data = await api("/preflight");
    element.replaceChildren();
    data.checks.forEach((check) => {
      const row = document.createElement("div");
      row.className = `preflight-row ${check.ok ? "ok" : "needs-action"}`;
      row.textContent = `${check.ok ? "✓" : "!"} ${check.label}: ${check.detail}`;
      element.appendChild(row);
    });
  } catch (error) {
    element.textContent = `${t("error")}: ${error.message}`;
  }
}

async function refreshModels() {
  const element = document.getElementById("model-status");
  if (!element) return;
  try {
    const data = await fetch(`${GATEWAY}/models`).then((response) =>
      response.json(),
    );
    element.textContent = [
      `${t("defaultModel")}: ${data.default}`,
      `${t("fallbacks")}: ${(data.fallbacks || []).join(", ") || `(${t("none")})`}`,
      "",
      `${t("providers")}:`,
      ...(data.providers || []).map(
        (provider) =>
          `  ${provider.hasKey ? "✓" : "·"} ${provider.id} — ${provider.name}`,
      ),
    ].join("\n");
  } catch (error) {
    element.textContent = `${t("error")}: ${error.message}`;
  }
}

function startApprovalPoll() {
  window.setInterval(() => void refreshApprovals(), 2500);
}

async function refreshApprovals() {
  const box = document.getElementById("approvals-box");
  const list = document.getElementById("approvals-list");
  if (!box || !list) return;
  try {
    const data = await fetch(`${GATEWAY}/approvals`).then((response) =>
      response.json(),
    );
    const pending = data.pending || [];
    if (pending.length && !box.dataset.pending) {
      const narrow = window.innerWidth <= 1180;
      document.body.classList.toggle("context-collapsed", narrow);
    }
    box.dataset.pending = pending.length ? "yes" : "";
    box.classList.toggle("hidden", !pending.length);
    list.replaceChildren();
    pending.forEach((approval) => {
      const card = document.createElement("div");
      card.className = "approval-card";
      const title = document.createElement("strong");
      title.textContent = approval.toolName;
      const description = document.createElement("div");
      description.textContent = approval.description;
      const args = document.createElement("pre");
      args.textContent = JSON.stringify(approval.args || {}, null, 0).slice(
        0,
        200,
      );
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(
        approvalButton(t("approve"), "btn primary", () =>
          decideApproval(approval.id, true),
        ),
        approvalButton(t("deny"), "btn danger", () =>
          decideApproval(approval.id, false),
        ),
      );
      card.append(title, description, args, actions);
      list.appendChild(card);
    });
  } catch {
    // Gateway can be offline while the desktop shell remains usable.
  }
}

function approvalButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.onclick = () => void onClick();
  return button;
}

async function decideApproval(id, approve) {
  await fetch(`${GATEWAY}/approvals/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approve }),
  });
  void refreshApprovals();
}

function setupAvatarGrid() {
  const grid = document.getElementById("avatar-grid");
  AVATARS.forEach((avatar) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `avatar-option${avatar.id === selectedAvatar ? " selected" : ""}`;
    button.title = avatar.label;
    const canvas = document.createElement("canvas");
    drawSprite(canvas, avatar.id, avatar.color, 5);
    button.appendChild(canvas);
    button.addEventListener("click", () => {
      selectedAvatar = avatar.id;
      grid
        .querySelectorAll(".avatar-option")
        .forEach((item) => item.classList.remove("selected"));
      button.classList.add("selected");
      paintHero(avatar.id);
    });
    grid.appendChild(button);
  });
}

function setupOnboard() {
  document.getElementById("onboard-btn").addEventListener("click", async () => {
    const name = document.getElementById("name-input").value.trim();
    if (!name) return alert(t("enterName"));
    const button = document.getElementById("onboard-btn");
    const status = document.getElementById("onboard-status");
    button.disabled = true;
    status.textContent = "Сохраняю профиль…";
    try {
      const data = await api("/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          avatarId: selectedAvatar,
          persona: document.getElementById("persona-input").value,
          locale: productLocale,
        }),
      });
      document.getElementById("agent-name").textContent = data.identity.name;
      paintHero(data.identity.avatarId);
      document.getElementById("onboard").classList.add("hidden");
      document.getElementById("chat").classList.remove("hidden");
      void refreshPreflight();
    } catch (error) {
      status.textContent = `${t("error")}: ${error.message}. Запустите gateway и повторите.`;
    } finally {
      button.disabled = false;
    }
  });
}

function setupChat() {
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const send = document.getElementById("chat-send");
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled) form.requestSubmit();
    }
  });
  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.prompt;
      input.focus();
    });
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || send.disabled) return;
    const thread = activeThread();
    const selected = [...selectedSkills];
    currentRequestId = crypto.randomUUID();
    input.value = "";
    thread.messages.push({ role: "user", content: text, skills: selected });
    if (thread.messages.length === 1) thread.title = text.slice(0, 65);
    saveThreads();
    renderConversation();
    document.getElementById("run-status").textContent =
      "Агент выполняет задачу…";
    setAvatarState("thinking");
    send.disabled = true;
    try {
      const response = await fetch(`${GATEWAY}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId: thread.sessionId || undefined,
          skillNames: selected,
          requestId: currentRequestId,
        }),
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      if (data.sessionId !== "desktop") thread.sessionId = data.sessionId;
      sessionId = thread.sessionId;
      setAvatarState("done");
      thread.messages.push({
        role: "assistant",
        content: data.response,
        tools: data.toolCallsExecuted || [],
      });
    } catch (error) {
      thread.messages.push({
        role: "assistant",
        content: `${t("error")}: ${error.message}`,
      });
    } finally {
      saveThreads();
      renderConversation();
      document.getElementById("run-status").textContent = "";
      currentRequestId = null;
      send.disabled = false;
      window.setTimeout(() => setAvatarState("idle"), 520);
    }
  });
}

function appendMsg(container, role, text, tools = []) {
  document.getElementById("chat-empty")?.classList.add("hidden");
  const element = document.createElement("div");
  element.className = `msg ${role}`;
  if (role === "assistant") {
    const label = document.createElement("div");
    label.className = "message-label";
    label.textContent = "HEYAGENT";
    element.append(label);
  }
  const body = document.createElement("div");
  if (role === "assistant") renderMessageText(body, text);
  else body.textContent = text;
  element.append(body);
  if (tools.length) {
    const detail = document.createElement("div");
    detail.className = "message-tools";
    detail.textContent = `Инструменты: ${tools.join(" · ")}`;
    element.append(detail);
  }
  container.appendChild(element);
  container.scrollTop = container.scrollHeight;
}

function renderMessageText(container, text) {
  let code = null;
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("```")) {
      if (code) code = null;
      else {
        code = document.createElement("pre");
        code.className = "data-card";
        container.append(code);
      }
      continue;
    }
    if (code) {
      code.textContent += `${line}\n`;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const row = document.createElement(
      heading ? `h${heading[1].length + 1}` : "div",
    );
    const content = heading ? heading[2] : line.replace(/^[-*] /, "• ");
    for (const part of content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
      if (part.startsWith("**") && part.endsWith("**")) {
        const strong = document.createElement("strong");
        strong.textContent = part.slice(2, -2);
        row.append(strong);
      } else if (part.startsWith("`") && part.endsWith("`")) {
        const inline = document.createElement("code");
        inline.textContent = part.slice(1, -1);
        row.append(inline);
      } else row.append(document.createTextNode(part));
    }
    if (!content) row.append(document.createElement("br"));
    container.append(row);
  }
}

const THREADS_KEY = "heyagent.desktop.threads.v1";
let threads = [];
try {
  const stored = JSON.parse(localStorage.getItem(THREADS_KEY) || "[]");
  threads = Array.isArray(stored)
    ? stored.filter(
        (s) => typeof s.id === "string" && Array.isArray(s.messages),
      )
    : [];
} catch {
  /* recover an invalid cache */
}
let activeThreadId = threads[0]?.id;
let selectedSkills = new Set();
let skillCatalog = [];
let emptyTemplate = "";
let currentRequestId = null;

function activeThread() {
  let thread = threads.find((item) => item.id === activeThreadId);
  if (!thread) {
    thread = {
      id: crypto.randomUUID(),
      title: "Новый чат",
      messages: [],
      sessionId: null,
    };
    threads.unshift(thread);
    activeThreadId = thread.id;
  }
  return thread;
}
function saveThreads() {
  try {
    localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
  } catch {
    document.getElementById("run-status").textContent =
      "Не удалось сохранить историю: хранилище заполнено.";
  }
  renderHistory();
}
function showView(name) {
  document
    .querySelectorAll(".tab")
    .forEach((item) =>
      item.classList.toggle("active", item.dataset.tab === name),
    );
  document
    .querySelectorAll(".panel")
    .forEach((item) => item.classList.add("hidden"));
  document
    .getElementById(name === "models" ? "models-panel" : name)
    ?.classList.remove("hidden");
  document.getElementById("view-title").textContent =
    {
      chat: activeThread().title,
      skills: "Навыки",
      missions: "Задачи",
      models: "Модели",
      connect: "Сервисы",
    }[name] || "HeyAgent";
  if (name === "skills") void refreshSkills();
  if (name === "missions") void refreshMissions();
  if (name === "models") void refreshModels();
  if (name === "connect") void refreshIntegrations();
}
function renderHistory() {
  const list = document.getElementById("chat-history");
  list.replaceChildren();
  const query = document.getElementById("chat-search").value.toLowerCase();
  threads
    .filter(
      (item) =>
        item.messages.length && item.title.toLowerCase().includes(query),
    )
    .forEach((thread) => {
      const button = document.createElement("button");
      button.className = `history-item${thread.id === activeThreadId ? " active" : ""}`;
      button.textContent = thread.title;
      button.title = thread.title;
      button.onclick = () => {
        if (document.getElementById("chat-send").disabled) return;
        activeThreadId = thread.id;
        selectedSkills = new Set();
        renderSelectedSkills();
        renderConversation();
        showView("chat");
      };
      list.append(button);
    });
  if (!list.childElementCount) {
    const hint = document.createElement("p");
    hint.className = "history-empty";
    hint.textContent = query
      ? "Чаты не найдены"
      : "Ваши разговоры появятся здесь. История сохраняется на этом устройстве.";
    list.append(hint);
  }
}
function renderConversation() {
  const thread = activeThread();
  sessionId = thread.sessionId;
  const messages = document.getElementById("messages");
  messages.replaceChildren();
  if (!thread.messages.length) {
    messages.innerHTML = emptyTemplate;
    messages.querySelectorAll("[data-prompt]").forEach((button) => {
      button.onclick = () => {
        document.getElementById("chat-input").value = button.dataset.prompt;
        document.getElementById("chat-input").focus();
      };
    });
  } else
    thread.messages.forEach((message) =>
      appendMsg(messages, message.role, message.content, message.tools || []),
    );
  document.getElementById("view-title").textContent = thread.title;
  renderHistory();
}
function setupWorkspace() {
  connectStatusEvents();
  emptyTemplate = document.getElementById("messages").innerHTML;
  activeThread();
  renderConversation();
  document.getElementById("new-chat").onclick = () => {
    if (document.getElementById("chat-send").disabled) return;
    activeThreadId = null;
    selectedSkills.clear();
    activeThread();
    renderSelectedSkills();
    renderConversation();
    showView("chat");
    document.getElementById("chat-input").focus();
  };
  document.getElementById("chat-search").oninput = renderHistory;
  document.getElementById("skill-search").oninput = renderSkills;
  for (const id of ["choose-skills", "context-skills"])
    document.getElementById(id).onclick = () => showView("skills");
  document.getElementById("composer-model").onclick = () => showView("models");
  document.getElementById("context-services").onclick = () =>
    showView("connect");
  for (const id of ["sidebar-toggle", "sidebar-open"])
    document.getElementById(id).onclick = () =>
      document.body.classList.toggle("sidebar-collapsed");
  document.getElementById("context-toggle").onclick = () =>
    document.body.classList.toggle("context-collapsed");
  document.getElementById("close-skill").onclick = () =>
    document.getElementById("skill-dialog").close();
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      document.getElementById("new-chat").click();
    }
  });
}
function connectStatusEvents() {
  const socket = new WebSocket(GATEWAY.replace(/^http/, "ws"));
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type !== "run_status" || data.requestId !== currentRequestId)
        return;
      const label =
        {
          thinking: "Обдумывает задачу",
          working: "Выполняет",
          done: "Проверка завершена",
          error: "Ошибка выполнения",
        }[data.status] || "В работе";
      document.getElementById("run-status").textContent =
        `${label}${data.detail ? ` · ${data.detail}` : "…"}`;
      setAvatarState(data.status);
    } catch {
      /* Ignore unrelated or malformed events. */
    }
  };
  socket.onclose = () => window.setTimeout(connectStatusEvents, 5000);
  socket.onerror = () => socket.close();
}
async function refreshSkills() {
  try {
    const data = await api("/skills");
    skillCatalog = data.skills;
    document.getElementById("skills-count").textContent = skillCatalog.length;
    document.getElementById("skill-status").textContent =
      `${skillCatalog.length} установленных навыков · ~/.heyagent/skills`;
    renderSkills();
  } catch {
    document.getElementById("skill-status").textContent =
      "Для загрузки навыков запустите gateway: hey gateway start";
  }
}
function toggleSkill(name) {
  if (selectedSkills.has(name)) selectedSkills.delete(name);
  else if (selectedSkills.size < 6) selectedSkills.add(name);
  else {
    document.getElementById("skill-status").textContent =
      "Для одного запроса можно выбрать до 6 навыков.";
    return;
  }
  renderSkills();
  renderSelectedSkills();
}
function renderSelectedSkills() {
  const list = document.getElementById("selected-skills");
  list.replaceChildren();
  selectedSkills.forEach((name) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "skill-chip";
    chip.textContent = `${name} ×`;
    chip.title = "Убрать навык";
    chip.onclick = () => toggleSkill(name);
    list.append(chip);
  });
  document.getElementById("context-skill-list").textContent =
    selectedSkills.size
      ? [...selectedSkills].join("\n")
      : "Автоматический подбор по запросу";
}
function renderSkills() {
  const grid = document.getElementById("skill-grid");
  grid.replaceChildren();
  const query = document.getElementById("skill-search").value.toLowerCase();
  skillCatalog
    .filter((skill) =>
      `${skill.name} ${skill.description}`.toLowerCase().includes(query),
    )
    .forEach((skill) => {
      const card = document.createElement("article");
      card.className = `skill-card${selectedSkills.has(skill.name) ? " selected" : ""}`;
      const title = document.createElement("h3");
      title.textContent = `✧ ${skill.name}`;
      const description = document.createElement("p");
      description.textContent = skill.description;
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(
        approvalButton(
          selectedSkills.has(skill.name) ? "✓ Выбран" : "+ Выбрать",
          "btn",
          () => toggleSkill(skill.name),
        ),
        approvalButton("Инструкции ↗", "btn", () => {
          document.getElementById("skill-dialog-title").textContent =
            skill.name;
          document.getElementById("skill-dialog-body").textContent = skill.body;
          document.getElementById("skill-dialog-select").onclick = () => {
            if (!selectedSkills.has(skill.name)) toggleSkill(skill.name);
            document.getElementById("skill-dialog").close();
            showView("chat");
          };
          document.getElementById("skill-dialog").showModal();
        }),
      );
      card.append(title, description, actions);
      grid.append(card);
    });
  if (!grid.childElementCount) grid.textContent = "Навыки не найдены.";
}
async function refreshIntegrations() {
  const list = document.getElementById("integration-list");
  try {
    const data = await api("/integrations");
    list.replaceChildren();
    data.integrations.forEach((integration) => {
      const row = document.createElement("li");
      row.textContent = `${integration.connected ? "●" : "○"} ${integration.name} — ${integration.connected ? "Подключён" : "Не подключён"}`;
      list.append(row);
    });
    document.getElementById("context-integrations").textContent =
      data.integrations
        .filter((item) => item.connected)
        .map((item) => `● ${item.name}`)
        .join(" · ") || "Нет подключённых сервисов";
  } catch {
    list.textContent = "Gateway недоступен. Запустите hey gateway start.";
    document.getElementById("context-integrations").textContent =
      "Gateway недоступен";
  }
}
init();
