import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodingTask } from "./coder-loop.js";
import type { ModelRef } from "@heyagent/models";

const model = { provider: "bedrock", model: "test" } as ModelRef;

test("coding task plans, writes and verifies a generic multi-file project", async () => {
  const root = await mkdtemp(join(tmpdir(), "heyagent-coder-"));
  const replies = [
    '{"files":[{"path":"index.html","purpose":"interface"},{"path":"data.json","purpose":"sample data"}]}',
    '<!doctype html><html><body><h1>Notes</h1><script>document.querySelector("h1").textContent = "Notes";</script></body></html>',
    '{"items":["first note"]}',
  ];
  try {
    const result = await runCodingTask("Create a notes app", root, model, undefined,
      (async () => ({ content: replies.shift() ?? "" })) as never);
    assert.match(result.response, /index\.html, data\.json/);
    assert.match(await readFile(join(root, "index.html"), "utf8"), /Notes/);
    assert.deepEqual(JSON.parse(await readFile(join(root, "data.json"), "utf8")), { items: ["first note"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding task rejects path traversal before any model file generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "heyagent-coder-"));
  try {
    await assert.rejects(runCodingTask("Create app", root, model, undefined,
      (async () => ({ content: '{"files":[{"path":"../outside.txt","purpose":"bad"}]}' })) as never), /Недопустимый путь/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding task repairs mismatched HTML and JavaScript IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "heyagent-coder-"));
  const replies = [
    '{"files":[{"path":"index.html","purpose":"page"},{"path":"script.js","purpose":"behavior"}]}',
    '<html><body><button id="addBtn">Add</button><script src="script.js"></script></body></html>',
    'document.getElementById("add-btn").click();',
    'document.getElementById("addBtn").click();',
  ];
  try {
    const result = await runCodingTask("Add a button", root, model, undefined,
      (async () => ({ content: replies.shift() ?? "" })) as never);
    assert.match(result.response, /script\.js/);
    assert.match(await readFile(join(root, "script.js"), "utf8"), /addBtn/);
    assert.equal(replies.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty app project rejects a plan without a runnable entry point and replans", async () => {
  const root = await mkdtemp(join(tmpdir(), "heyagent-coder-"));
  const replies = [
    '{"files":[{"path":"todo.js","purpose":"logic"}]}',
    '{"files":[{"path":"index.html","purpose":"runnable page"}]}',
    '<html><body><h1>Todo</h1></body></html>',
  ];
  try {
    const result = await runCodingTask("Create a todo app", root, model, undefined,
      (async () => ({ content: replies.shift() ?? "" })) as never);
    assert.match(result.response, /index\.html/);
    assert.equal(replies.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
