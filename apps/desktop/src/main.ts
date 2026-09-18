import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GATEWAY_DEFAULT_PORT } from "@heyagent/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_DEFAULT_PORT}`;

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 760,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#191919",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: "HeyAgent",
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  void mainWindow.loadFile(join(__dirname, "ui", "index.html"));
  mainWindow.on("close", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    mainWindow?.hide();
  });
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${GATEWAY_URL}${path}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function refreshTrayMenu(): Promise<void> {
  if (!tray) return;
  let statusLabel = "Gateway offline";
  let missionLabel = "Missions: —";
  try {
    const status = (await fetchJson("/status")) as {
      ok?: boolean;
      model?: string;
      missions?: { total?: number; activeUi?: string | null };
    };
    statusLabel = status.ok
      ? `Online · ${status.model || "?"}`
      : "Gateway offline";
    const n = status.missions?.total ?? 0;
    const active = status.missions?.activeUi ? " · active" : "";
    missionLabel = `Missions: ${n}${active}`;
  } catch {
    /* offline */
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
      { label: missionLabel, click: () => showMissionsTab() },
      { type: "separator" },
      { label: "Open HeyAgent", click: () => mainWindow?.show() },
      {
        label: "Refresh status",
        click: () => {
          void refreshTrayMenu();
        },
      },
      {
        label: "Cancel all missions",
        click: async () => {
          try {
            await fetch(`${GATEWAY_URL}/missions/cancel`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
          } catch {
            /* ignore */
          }
          void refreshTrayMenu();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function showMissionsTab(): void {
  mainWindow?.show();
  mainWindow?.webContents.executeJavaScript(
    `document.querySelector('[data-tab="missions"]')?.click()`,
  );
}

function createTray(): void {
  const iconSvg = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" shape-rendering="crispEdges"><rect width="16" height="16" rx="3" fill="#0f1419"/><rect x="3" y="2" width="10" height="11" fill="#a855f7"/><rect x="5" y="5" width="2" height="2" fill="#fff"/><rect x="9" y="5" width="2" height="2" fill="#fff"/><rect x="5" y="10" width="6" height="1" fill="#542a7b"/></svg>',
  );
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml,${iconSvg}`);
  tray = new Tray(icon);
  tray.setToolTip("HeyAgent");
  void refreshTrayMenu();
  tray.on("click", () => mainWindow?.show());
  setInterval(() => {
    void refreshTrayMenu();
  }, 15_000);
}

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on("window-all-closed", () => {
  // Keep HeyAgent available in the tray; the tray's Quit action exits it.
});

export { GATEWAY_URL };
