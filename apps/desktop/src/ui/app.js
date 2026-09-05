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
    connecting: "Connecting…", online: "Online", offline: "Offline",
    gatewayOffline: "Gateway offline — run: hey gateway start",
    firstLaunch: "FIRST LAUNCH", onboardTitle: "Name your agent",
    onboardCopy: "Create your personal assistant — you can change these settings later.",
    agentName: "Agent name", avatarTitle: "Pick an avatar", continue: "Continue",
    readyTitle: "Ready when you are", readyCopy: "Ask anything or delegate a task.",
    chatPlaceholder: "Ask anything…", send: "Send", chat: "Chat",
    automation: "AUTOMATION", missions: "Missions", refresh: "Refresh", pause: "Pause",
    cancelAll: "Cancel all", queue: "Queue", history: "History", safePreview: "Safe preview",
    intelligence: "INTELLIGENCE", models: "Models", configureTerminal: "Configure from the terminal:",
    testConnection: "Test connection", workspace: "WORKSPACE", services: "Services",
    connect: "Connect", connectCopy: "Connect Google Workspace, Notion and other services from the terminal.",
    run: "Run:", or: "or", enterName: "Enter a name",
    terminalSetup: "Run in terminal to complete setup", name: "Name", avatar: "Avatar",
    model: "Model", activeUi: "Active UI", pendingApprovals: "Pending approvals",
    cron: "Cron", none: "none", queueEmpty: "Queue empty", noHistory: "No history yet",
    defaultModel: "Default", fallbacks: "Fallbacks", providers: "Providers",
    error: "Error", approve: "Approve", deny: "Deny",
  },
  ru: {
    connecting: "Подключение…", online: "В сети", offline: "Не в сети",
    gatewayOffline: "Шлюз не запущен — выполните: hey gateway start",
    firstLaunch: "ПЕРВЫЙ ЗАПУСК", onboardTitle: "Назовите агента",
    onboardCopy: "Создайте персонального помощника — настройки можно изменить позже.",
    agentName: "Имя агента", avatarTitle: "Выберите аватар", continue: "Продолжить",
    readyTitle: "Готов к работе", readyCopy: "Спросите что угодно или поручите задачу.",
    chatPlaceholder: "Напишите запрос…", send: "Отправить", chat: "Чат",
    automation: "АВТОМАТИЗАЦИЯ", missions: "Задачи", refresh: "Обновить", pause: "Пауза",
    cancelAll: "Отменить все", queue: "Очередь", history: "История",
    safePreview: "Безопасное подтверждение", intelligence: "ИНТЕЛЛЕКТ", models: "Модели",
    configureTerminal: "Настройте через терминал:", testConnection: "Проверить подключение",
    workspace: "РАБОЧЕЕ ПРОСТРАНСТВО", services: "Сервисы", connect: "Связи",
    connectCopy: "Подключайте Google Workspace, Notion и другие сервисы из терминала.",
    run: "Выполните:", or: "или", enterName: "Введите имя",
    terminalSetup: "Завершите настройку в терминале", name: "Имя", avatar: "Аватар",
    model: "Модель", activeUi: "Активный UI", pendingApprovals: "Ожидают подтверждения",
    cron: "Расписание", none: "нет", queueEmpty: "Очередь пуста",
    noHistory: "Истории пока нет", defaultModel: "По умолчанию",
    fallbacks: "Резервные", providers: "Провайдеры", error: "Ошибка",
    approve: "Разрешить", deny: "Отклонить",
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
  if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
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
  "sprite-01": [[0,1,1,1,1,1,1,0],[1,1,3,1,1,3,1,1],[1,1,1,1,1,1,1,1],[1,2,2,2,2,2,2,1],[0,1,1,1,1,1,1,0],[0,1,0,1,1,0,1,0],[0,1,0,1,1,0,1,0],[0,2,0,0,0,0,2,0]],
  "sprite-02": [[0,0,4,4,4,4,0,0],[0,1,1,1,1,1,1,0],[1,3,1,1,1,1,3,1],[1,1,1,2,2,1,1,1],[0,1,1,1,1,1,1,0],[0,0,1,1,1,1,0,0],[0,1,0,0,0,0,1,0],[0,2,0,0,0,0,2,0]],
  "sprite-03": [[0,0,1,1,1,1,0,0],[0,1,4,4,4,4,1,0],[1,3,1,1,1,1,3,1],[1,1,1,1,1,1,1,1],[0,1,2,2,2,2,1,0],[0,0,1,1,1,1,0,0],[0,1,1,0,0,1,1,0],[2,2,0,0,0,0,2,2]],
  "sprite-04": [[0,4,0,1,1,0,4,0],[0,0,1,1,1,1,0,0],[0,1,3,1,1,3,1,0],[1,1,1,2,2,1,1,1],[0,1,1,1,1,1,1,0],[0,0,1,1,1,1,0,0],[0,1,0,0,0,0,1,0],[0,4,0,0,0,0,4,0]],
  "sprite-05": [[0,0,1,1,1,1,0,0],[0,1,1,1,1,1,1,0],[1,3,4,1,1,4,3,1],[1,1,1,1,1,1,1,1],[0,1,2,1,1,2,1,0],[0,0,1,1,1,1,0,0],[0,0,1,0,0,1,0,0],[0,0,2,0,0,2,0,0]],
  "sprite-06": [[0,0,0,4,4,0,0,0],[0,4,1,1,1,1,4,0],[0,1,3,1,1,3,1,0],[1,1,1,1,1,1,1,1],[0,1,1,2,2,1,1,0],[0,0,1,1,1,1,0,0],[0,1,0,0,0,0,1,0],[4,0,0,0,0,0,0,4]],
  "sprite-07": [[0,0,1,1,1,1,0,0],[0,1,1,1,1,1,1,0],[1,3,1,1,1,1,3,1],[1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1],[1,1,0,1,1,0,1,1],[1,0,0,1,1,0,0,1],[1,0,0,0,0,0,0,1]],
  "sprite-08": [[0,2,2,2,2,2,2,0],[2,1,1,1,1,1,1,2],[1,3,1,1,1,1,3,1],[1,1,1,4,4,1,1,1],[2,1,1,1,1,1,1,2],[0,2,1,1,1,1,2,0],[0,1,0,0,0,0,1,0],[0,2,0,0,0,0,2,0]],
  "sprite-09": [[0,0,0,4,0,0,0,0],[0,0,1,1,1,0,0,0],[0,1,3,1,3,1,0,0],[0,1,1,1,1,1,0,0],[0,0,1,4,1,0,0,0],[0,0,0,1,0,0,4,0],[0,4,0,1,0,0,0,0],[0,0,0,2,0,0,0,0]],
  "sprite-10": [[0,2,1,1,1,1,2,0],[2,1,1,1,1,1,1,2],[1,3,2,1,1,2,3,1],[1,1,1,4,4,1,1,1],[1,1,1,1,1,1,1,1],[2,1,1,1,1,1,1,2],[0,2,1,0,0,1,2,0],[0,0,2,0,0,2,0,0]],
  "sprite-11": [[0,4,0,4,4,0,4,0],[0,0,1,1,1,1,0,0],[4,1,3,1,1,3,1,4],[0,1,1,1,1,1,1,0],[0,0,1,2,2,1,0,0],[0,0,1,1,1,1,0,0],[0,1,0,0,0,0,1,0],[0,2,0,0,0,0,2,0]],
  "sprite-12": [[0,2,0,0,0,0,2,0],[0,0,1,1,1,1,0,0],[0,1,3,1,1,3,1,0],[1,1,4,1,1,4,1,1],[0,1,1,2,2,1,1,0],[0,0,1,1,1,1,0,0],[0,0,1,0,0,1,0,0],[0,0,2,0,0,2,0,0]],
};

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function shade([r, g, b], factor) {
  return [Math.min(255, Math.round(r * factor)), Math.min(255, Math.round(g * factor)), Math.min(255, Math.round(b * factor))];
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
  const palette = { 1: main, 2: shade(main, 0.45), 3: [10, 13, 23], 4: shade(main, 1.35) };
  const frame = avatarFrame % 4;
  const frameX = animated && avatarState === "working" ? (frame % 2 ? scale : -scale) : 0;
  const frameY = animated && avatarState === "thinking" && (frame === 1 || frame === 2) ? -scale : 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let pixel = grid[y][x];
      if (animated && avatarState === "idle" && frame === 3 && y === 2 && pixel === 3) pixel = 1;
      if (!pixel) continue;
      const [r, g, b] = palette[pixel];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(margin + x * scale + frameX, margin + y * scale + frameY, scale, scale);
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
    status.textContent = `${t("online")} · ${gatewayStatus.model || "HeyAgent"}`;
  } else if (gatewayStatus) {
    dot.classList.add("offline");
    status.textContent = t("offline");
  } else {
    dot.classList.add("offline");
    status.textContent = t("gatewayOffline");
  }
}

async function init() {
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
    showOnboarding();
  }
}

function setupLocaleSwitch() {
  document.querySelectorAll("[data-locale]").forEach((button) => {
    button.addEventListener("click", () => applyProductLocale(button.dataset.locale));
  });
}

function showOnboarding() {
  document.getElementById("onboard").classList.remove("hidden");
  document.getElementById("chat").classList.add("hidden");
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".panel").forEach((panel) => panel.classList.add("hidden"));
      const name = tab.dataset.tab;
      document.getElementById(name === "models" ? "models-panel" : name)?.classList.remove("hidden");
      if (name === "missions") void refreshMissions();
      if (name === "models") void refreshModels();
    });
  });
}

function setupMissions() {
  document.getElementById("missions-refresh")?.addEventListener("click", () => void refreshMissions());
  document.getElementById("missions-pause")?.addEventListener("click", async () => {
    await api("/missions/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    void refreshMissions();
  });
  document.getElementById("missions-cancel")?.addEventListener("click", async () => {
    await api("/missions/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
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
      "", `${t("cron")}:`, missions.cron || `(${t("none")})`,
    ].join("\n");
    renderMissionList(queueEl, missions.queue || []);
    renderList(historyEl, missions.history || [], t("noHistory"), (item) =>
      `${(item.at || "").slice(0, 16)} · ${item.harness || "?"} — ${(item.goal || "").slice(0, 70)}`);
  } catch {
    statusEl.textContent = t("gatewayOffline");
  }
}

function renderMissionList(element, missions) {
  element.replaceChildren();
  if (!missions.length) return renderList(element, [], t("queueEmpty"), () => "");
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
        approvalButton(t("pause"), "btn", () => missionAction("pause", mission.id)),
        approvalButton(t("cancelAll"), "btn danger", () => missionAction("cancel", mission.id)),
      );
    }
    li.append(title, meta, actions);
    element.appendChild(li);
  });
}

async function missionAction(action, id) {
  await api(`/missions/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
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
  document.getElementById("test-model")?.addEventListener("click", () => void testModel());
  document.getElementById("run-preflight")?.addEventListener("click", () => void refreshPreflight());
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
    const data = await fetch(`${GATEWAY}/models`).then((response) => response.json());
    element.textContent = [
      `${t("defaultModel")}: ${data.default}`,
      `${t("fallbacks")}: ${(data.fallbacks || []).join(", ") || `(${t("none")})`}`,
      "", `${t("providers")}:`,
      ...(data.providers || []).map((provider) => `  ${provider.hasKey ? "✓" : "·"} ${provider.id} — ${provider.name}`),
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
    const data = await fetch(`${GATEWAY}/approvals`).then((response) => response.json());
    const pending = data.pending || [];
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
      args.textContent = JSON.stringify(approval.args || {}, null, 0).slice(0, 200);
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(
        approvalButton(t("approve"), "btn primary", () => decideApproval(approval.id, true)),
        approvalButton(t("deny"), "btn danger", () => decideApproval(approval.id, false)),
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
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve }),
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
      grid.querySelectorAll(".avatar-option").forEach((item) => item.classList.remove("selected"));
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
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, avatarId: selectedAvatar, persona: document.getElementById("persona-input").value, locale: productLocale }),
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
  const messages = document.getElementById("messages");
  const send = document.getElementById("chat-send");
  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.prompt;
      input.focus();
    });
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    appendMsg(messages, "user", text);
    setAvatarState("thinking");
    send.disabled = true;
    try {
      const response = await fetch(`${GATEWAY}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId }),
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      sessionId = data.sessionId;
      setAvatarState("done");
      appendMsg(messages, "assistant", data.response);
    } catch (error) {
      appendMsg(messages, "assistant", `${t("error")}: ${error.message}`);
    } finally {
      send.disabled = false;
      window.setTimeout(() => setAvatarState("idle"), 520);
    }
  });
}

function appendMsg(container, role, text) {
  document.getElementById("chat-empty")?.classList.add("hidden");
  const element = document.createElement("div");
  element.className = `msg ${role}`;
  element.textContent = text;
  container.appendChild(element);
  container.scrollTop = container.scrollHeight;
}

init();
