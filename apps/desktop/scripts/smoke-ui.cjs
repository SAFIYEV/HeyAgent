// Isolated renderer regression check. No real gateway, credentials or model calls.
const { app, BrowserWindow } = require("electron");
const { createServer } = require("node:http");
const { readFile, mkdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const assert = require("node:assert/strict");
const { tmpdir } = require("node:os");
app.setPath("userData", join(tmpdir(), `heyagent-ui-check-${process.pid}`));
let submitted;
let offline = false;
const skills = [{ name: "research-report", description: "Исследование темы и создание отчёта с источниками", body: "Read sources, verify evidence and write a report." }, { name: "notepad", description: "Заметки и тексты на вашем компьютере", body: "Preserve the requested genre." }];
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const routes = {
      "/status": { ok: true, model: "bedrock/qwen.qwen3-coder-next", policyMode: "ask", locale: "ru" },
      "/identity": { identity: { name: "Marat", avatarId: "sprite-09" } },
      "/skills": { skills }, "/approvals": { pending: [] },
      "/integrations": { integrations: [{ name: "Google Workspace", connected: true }, { name: "Gmail", connected: true }] },
      "/missions": { queue: [], history: [], cron: [] },
      "/models": { default: "bedrock/qwen.qwen3-coder-next", providers: [], fallbacks: [] },
    };
    if (offline && routes[path]) { res.writeHead(503); res.end("{}"); return; }
    if (path === "/chat") {
      let body = ""; for await (const chunk of req) body += chunk;
      submitted = JSON.parse(body);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ sessionId: "test-session", response: "## Готово\n\n**Результат проверен.**\n\n- Найдены источники\n- Подготовлен отчёт\n\n<script>window.injected=true</script>", toolCallsExecuted: ["web.search", "report.write"] })); return;
    }
    if (routes[path]) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(routes[path])); return; }
    const name = path === "/" ? "index.html" : path.slice(1);
    if (!["index.html", "app.js", "styles.css"].includes(name)) { res.writeHead(404); res.end(); return; }
    let body = await readFile(join(__dirname, "../src/ui", name), "utf8");
    if (name === "app.js") body = body.replace("http://127.0.0.1:28789", `http://127.0.0.1:${server.address().port}`);
    res.setHeader("Content-Type", name.endsWith("js") ? "text/javascript" : name.endsWith("css") ? "text/css" : "text/html"); res.end(body);
  } catch (err) { res.writeHead(500); res.end(String(err)); }
});
async function main() {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const win = new BrowserWindow({ show: false, width: 1440, height: 940, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const js = (code) => win.webContents.executeJavaScript(code);
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  await js(`Promise.all([refreshSkills(), refreshIntegrations()])`);
  await js(`api('/status').then(data => { gatewayStatus = data; renderGatewayStatus(); })`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const output = join(__dirname, "../../../out/ui-check"); await mkdir(output, { recursive: true });
  await writeFile(join(output, "desktop-home.png"), (await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('[data-tab="skills"]').click(); refreshSkills()`);
  assert.equal(await js(`document.querySelectorAll('.skill-card').length`), 2);
  await js(`document.querySelector('.skill-card .btn').click(); document.querySelector('[data-tab="chat"]').click()`);
  assert.equal(await js(`document.querySelectorAll('.skill-chip').length`), 1);
  await js(`document.getElementById('chat-input').value = 'Подготовь отчёт'; document.getElementById('chat-form').requestSubmit()`);
  for (let i = 0; i < 50 && await js(`document.getElementById('chat-send').disabled`); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(submitted.skillNames, ["research-report"]);
  assert.equal(await js(`document.querySelectorAll('.msg').length`), 2);
  assert.equal(await js(`Boolean(window.injected)`), false);
  await writeFile(join(output, "desktop-chat.png"), (await win.webContents.capturePage()).toPNG());
  await js(`document.getElementById('new-chat').click()`);
  assert.equal(await js(`document.querySelectorAll('.msg').length`), 0);
  await js(`document.querySelector('.history-item').click()`);
  assert.equal(await js(`sessionId`), "test-session");
  await win.reload();
  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  assert.equal(await js(`threads.some(t => t.sessionId === 'test-session')`), true);
  await js(`showView('skills'); refreshSkills()`);
  await writeFile(join(output, "desktop-skills.png"), (await win.webContents.capturePage()).toPNG());
  win.setSize(800, 700);
  await js(`showView('chat')`);
  assert.equal(await js(`document.documentElement.scrollWidth <= window.innerWidth`), true);
  offline = true;
  await js(`refreshSkills()`);
  assert.ok(await js(`document.getElementById('skill-status').textContent.includes('gateway')`));
  console.log(`UI smoke passed: skill selection, request payload, safe rendering, history, reload, narrow layout, offline state. Screenshots: ${output}`);
  win.destroy(); server.close(); app.quit();
}
main().catch((err) => { console.error(err); server.close(); app.exit(1); });
