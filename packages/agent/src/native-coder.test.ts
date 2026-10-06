import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativeCodingTask, todoQualityFailure } from "./native-coder.js";
import type { ChatMessage, ModelRef } from "@heyagent/models";

const model = { provider: "bedrock", model: "qwen.qwen3-32b" } as ModelRef;
const call = (name: string, args: Record<string, unknown>, id: string) => ({ content: "", toolCalls: [{ id, name, arguments: args }] });

test("native coding loop uses tools, verifies files, and carries project memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "heyagent-native-"));
  const page = '<html><body><h1>Todo</h1><button id="add">Add</button><script>document.getElementById("add").onclick = () => {};</script></body></html>';
  const replies = [call("workspace_list", { path: "." }, "1"), call("workspace_write", { path: "index.html", content: page }, "2"), call("workspace_check", {}, "3"), { content: "Done" }];
  const requests: unknown[] = [];
  try {
    const result = await runNativeCodingTask("Create a todo app", root, model, {
      previousWork: "Previous calculator in calc/index.html",
      recentTurns: [{ role: "user", content: "create calculator" }],
    }, undefined, (async (_model: ModelRef, messages: ChatMessage[]) => { requests.push(messages.map((m) => ({ ...m }))); return replies.shift()!; }) as never);
    assert.deepEqual(result.files, ["index.html"]);
    assert.match(result.response, /PASS/);
    assert.match(await readFile(join(root, "index.html"), "utf8"), /Todo/);
    assert.match(JSON.stringify(requests[0]), /Previous calculator/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("todo quality gate rejects a decorative scaffold and accepts repaired functionality", async () => {
  const root = await mkdtemp(join(tmpdir(), "heyagent-native-quality-"));
  const scaffold = '<html><body><input><button>Add</button></body></html>';
  const complete = '<html><style>:root{font-family:Inter,system-ui;border-radius:12px;background:linear-gradient(#111,#222)}:focus-visible{outline:2px solid}</style><body><input><button>Добавить</button><button>Редактировать</button><button>Удалить</button><button>Выполнено</button><button>Фильтр</button><script>localStorage.setItem("tasks","[]")</script>@media</body></html>';
  const replies = [
    call("workspace_list", { path: "." }, "1"),
    call("workspace_write", { path: "index.html", content: scaffold }, "2"),
    call("workspace_check", {}, "3"),
    call("workspace_write", { path: "index.html", content: complete }, "4"),
    call("workspace_check", {}, "5"),
    { content: "Done" },
  ];
  const toolOutputs: string[] = [];
  try {
    const result = await runNativeCodingTask("создай todoapp", root, model, { developmentSkill: "Build a usable application" }, undefined,
      (async (_model: ModelRef, messages: ChatMessage[]) => {
        toolOutputs.push(...messages.filter((message) => message.role === "tool").map((message) => message.content));
        return replies.shift()!;
      }) as never);
    assert.ok(toolOutputs.some((output) => /FAIL: todoapp не завершён/.test(output)));
    assert.match(result.response, /PASS:/);
    assert.equal(await readFile(join(root, "index.html"), "utf8"), complete);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("todo verification rejects filtered-list index mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "heyagent-native-filter-"));
  const base = '<html><style>:root{font-family:Inter,system-ui;border-radius:12px;background:linear-gradient(#111,#222)}:focus-visible{outline:2px solid}@media(max-width:600px){body{width:100%}}</style><body><button>Редактировать</button><button>Удалить</button><button>Выполнено</button><button>Фильтр</button><script>const todos=[]; localStorage.setItem("tasks","[]"); const shown=todos.filter(x=>x.done); shown.forEach((todo,index)=>{ CHANGE.completed=true; });</script></body></html>';
  const buggy = base.replace("CHANGE", "todos[index]");
  const repaired = base.replace("CHANGE", "todo");
  const replies = [call("workspace_list", { path: "." }, "1"), call("workspace_write", { path: "index.html", content: buggy }, "2"), call("workspace_check", {}, "3"), call("workspace_write", { path: "index.html", content: repaired }, "4"), call("workspace_check", {}, "5"), { content: "Done" }];
  const outputs: string[] = [];
  try {
    const result = await runNativeCodingTask("создай todoapp", root, model, { developmentSkill: "Build a usable application" }, undefined,
      (async (_model: ModelRef, messages: ChatMessage[]) => {
        outputs.push(...messages.filter(message => message.role === "tool").map(message => message.content));
        return replies.shift()!;
      }) as never);
    assert.ok(outputs.some(output => /индекс отфильтрованного списка/.test(output)));
    assert.match(result.response, /PASS:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("todo quality rules catch edit controls that accidentally toggle completion", () => {
  const broken = "editBtn.addEventListener('click', () => { task.completed = !task.completed; });";
  assert.match(todoQualityFailure(broken) ?? "", /обработчик редактирования/);
  const indexedDelete = "const shown = tasks.filter(task => task.done); tasks = tasks.filter((_, index) => index !== index);";
  assert.match(todoQualityFailure(indexedDelete) ?? "", /удаление по индексу/);
});

test("todo quality rules require create and edit to update visible state", () => {
  assert.match(todoQualityFailure("function addTask(){ localStorage.setItem('tasks','[]'); } function renderTasks(){}") ?? "", /после добавления/);
  assert.match(todoQualityFailure("function editTask(){ localStorage.setItem('tasks','[]'); } function renderTasks(){}") ?? "", /после редактирования/);
  const good = "<style>:focus-visible{outline:2px}@media(max-width:600px){body{width:100%}} body{font-family:Inter,system-ui;border-radius:12px;background:linear-gradient(#111,#222)}</style><button>Редактировать</button><button>Удалить</button><button>Выполнено</button><button>Фильтр</button><script>localStorage.setItem('tasks','[]'); function addTask(){ save(); renderTasks(); } function editTask(){ save(); renderTasks(); } function renderTasks(){}</script>";
  assert.equal(todoQualityFailure(good), null);
});

test("native coding loop installs and verifies the bundled Todo app after two failed repairs", async () => {
  const root = await mkdtemp(join(tmpdir(), "heyagent-native-todo-fallback-"));
  const scaffold = '<html><body><h1>Todo</h1></body></html>';
  const replies = [
    call("workspace_list", { path: "." }, "1"),
    call("workspace_write", { path: "index.html", content: scaffold }, "2"),
    call("workspace_check", {}, "3"),
    call("workspace_write", { path: "index.html", content: scaffold }, "4"),
    call("workspace_check", {}, "5"),
  ];
  try {
    const result = await runNativeCodingTask("создай todoapp", root, model, { developmentSkill: "Build a usable application" }, undefined,
      (async () => replies.shift()!) as never);
    const html = await readFile(join(root, "index.html"), "utf8");
    assert.match(result.response, /встроенный Todo-шаблон проверен/);
    assert.match(html, /data-filter="active"/);
    assert.match(html, /localStorage/);
    assert.match(html, /function render\(/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native coding loop rejects file writes outside selected folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "heyagent-native-"));
  const replies = [call("workspace_list", { path: "." }, "1"), call("workspace_write", { path: "../outside.txt", content: "bad" }, "2"), { content: "Done" }, { content: "Done" }, { content: "Done" }];
  try {
    const result = await runNativeCodingTask("Create app", root, model, {}, undefined,
      (async () => replies.shift()!) as never);
    assert.deepEqual(result.files, []);
    assert.match(result.response, /не создала ни одного файла/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new app cannot overwrite an unrelated project in the selected folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "heyagent-native-"));
  const original = "<html><body>Calculator</body></html>";
  const todo = "<html><body>Todo</body></html>";
  await writeFile(join(root, "index.html"), original);
  const replies = [
    call("workspace_list", { path: "." }, "1"),
    call("workspace_read", { path: "index.html" }, "2"),
    call("workspace_write", { path: "index.html", content: todo }, "3"),
    call("workspace_write", { path: "todo/index.html", content: todo }, "4"),
    call("workspace_check", {}, "5"),
    { content: "Done" },
  ];
  try {
    const result = await runNativeCodingTask("создай мне todoapp", root, model, {}, undefined,
      (async () => replies.shift()!) as never);
    assert.deepEqual(result.files, ["todo/index.html"]);
    assert.equal(await readFile(join(root, "index.html"), "utf8"), original);
    assert.equal(await readFile(join(root, "todo", "index.html"), "utf8"), todo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native coding loop can run real project commands through workspace_shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "heyagent-native-shell-"));
  const page = '<html><body><h1>App</h1></body></html>';
  const replies = [
    call("workspace_list", { path: "." }, "1"),
    call("workspace_write", { path: "index.html", content: page }, "2"),
    call("workspace_shell", { command: "git status --short" }, "3"),
    call("workspace_shell", { command: "git push origin main" }, "4"),
    call("workspace_check", {}, "5"),
    { content: "Done" },
  ];
  const outputs: string[] = [];
  try {
    const result = await runNativeCodingTask("Create app and show git status", root, model, {}, undefined,
      (async (_model: ModelRef, messages: ChatMessage[]) => {
        outputs.push(...messages.filter((message) => message.role === "tool").map((message) => message.content));
        return replies.shift()!;
      }) as never);
    assert.ok(result.tools.includes("shell.exec"));
    assert.ok(outputs.some((output) => /EXIT/.test(output)), "shell returned real exit evidence");
    assert.ok(outputs.some((output) => /заблокирована/.test(output)), "git push blocked");
    assert.match(result.response, /PASS:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlink inside the project cannot create files outside it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "heyagent-native-"));
  const outside = await mkdtemp(join(tmpdir(), "heyagent-outside-"));
  try {
    try { await symlink(outside, join(root, "escape"), "junction"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("symlinks unavailable"); return; } throw error; }
    const replies = [call("workspace_list", { path: "." }, "1"), call("workspace_write", { path: "escape/new/file.txt", content: "bad" }, "2"), { content: "Done" }, { content: "Done" }, { content: "Done" }];
    const result = await runNativeCodingTask("Create app", root, model, {}, undefined,
      (async () => replies.shift()!) as never);
    assert.deepEqual(result.files, []);
    await assert.rejects(stat(join(outside, "new")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
