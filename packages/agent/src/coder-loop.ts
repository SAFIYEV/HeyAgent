import { chatCompletion, type ModelRef } from "@heyagent/models";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { Script } from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_FILES = 6;
const MAX_FILE_CHARS = 32_000;

export interface CodingResult {
  response: string;
  tools: string[];
  files: string[];
  /** Git commit hash when changes were committed. */
  commitHash?: string;
  /** Citations for verification evidence. */
  citations?: string[];
}

export interface CodingContext {
  recentTurns?: { role: "user" | "assistant"; content: string }[];
  previousWork?: string;
  projectInstructions?: string;
  developmentSkill?: string;
  stack?: string;
}

function inside(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("\\") || /^[a-z]:/i.test(path)) {
    throw new Error(`Недопустимый путь: ${path}`);
  }
  return target;
}

function parsePlan(text: string): { files: { path: string; purpose: string }[] } {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Модель не вернула план файлов");
  const plan = JSON.parse(match[0]) as { files?: { path?: unknown; purpose?: unknown }[] };
  if (!Array.isArray(plan.files) || !plan.files.length || plan.files.length > MAX_FILES) {
    throw new Error("Некорректное количество файлов в плане");
  }
  const files = plan.files.map((file) => {
    if (typeof file.path !== "string" || typeof file.purpose !== "string" || file.path.length > 160) {
      throw new Error("Некорректный файл в плане");
    }
    return { path: file.path, purpose: file.purpose };
  });
  if (new Set(files.map((file) => file.path.toLowerCase())).size !== files.length) {
    throw new Error("План содержит повторяющиеся файлы");
  }
  return { files };
}

function unwrap(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return (fence ? fence[1] : trimmed).trim() + "\n";
}

export function validateCodingFile(path: string, content: string): void {
  if (!content.trim() || content.length > MAX_FILE_CHARS) {
    throw new Error(`Неполное содержимое ${path}`);
  }
  const ext = extname(path).toLowerCase();
  if (ext === ".json") JSON.parse(content);
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") new Script(content);
  if (ext === ".html") {
    if (!/<html\b/i.test(content) || !/<\/html>/i.test(content)) throw new Error(`Неполный HTML: ${path}`);
    for (const script of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (script[1].trim()) new Script(script[1]);
    }
  }
  if (/\beval\s*\(|new\s+Function\s*\(/.test(content)) throw new Error(`Небезопасный код: ${path}`);
  if (/\.innerHTML\s*=\s*`/.test(content) || /\.insertAdjacentHTML\s*\(/.test(content)) {
    throw new Error(`Небезопасная вставка HTML: ${path}`);
  }
}

async function tree(root: string, folder = root, depth = 0): Promise<string[]> {
  if (depth > 2) return [];
  const entries = await readdir(folder, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (result.length >= 60) break;
    if (/^(node_modules|\.git|dist|build|out|\.next)$/i.test(entry.name)) continue;
    const absolute = resolve(folder, entry.name);
    result.push(relative(root, absolute).replaceAll("\\", "/") + (entry.isDirectory() ? "/" : ""));
    if (entry.isDirectory()) result.push(...(await tree(root, absolute, depth + 1)).slice(0, 60 - result.length));
  }
  return result.slice(0, 60);
}

export async function runCodingTask(
  request: string,
  workspaceDir: string,
  modelRef: ModelRef,
  onStatus?: (status: "thinking" | "working", detail?: string) => void,
  complete: typeof chatCompletion = chatCompletion,
  fallbacks: ModelRef[] = [],
  codingContext: CodingContext = {},
): Promise<CodingResult> {
  const root = resolve(workspaceDir);
  if (!(await stat(root)).isDirectory()) throw new Error("Рабочая папка недоступна");
  onStatus?.("thinking", "Осматриваю проект" + (codingContext.stack ? " · стек: " + codingContext.stack : ""));
  const entries = await tree(root);
  const contextFiles = ["package.json", "README.md", "index.html", "src/index.ts", "src/main.ts"];
  const context: string[] = [];
  for (const name of contextFiles) {
    if (!entries.includes(name)) continue;
    const source = await readFile(inside(root, name), "utf8").catch(() => "");
    if (source) context.push(`${name}:\n${source.slice(0, 4000)}`);
  }
  const common = { maxTokens: 1000, timeoutMs: 45_000, sameModelRetries: 1, fallbacks, useDefaultFallbacks: false } as const;
  const planReply = await complete(modelRef, [
    { role: "system", content: "You are a coding agent. Plan the smallest complete change for the user request in the selected folder. Return ONLY JSON: {\"files\":[{\"path\":\"relative/path\",\"purpose\":\"what to implement\"}]}. Maximum 6 files. Respect existing files and stack. If the user requests a new unrelated app in a folder with existing work, create a descriptive subfolder instead of overwriting that work. No prose.\nSTACK DECISION: " + (codingContext.stack || "inspect and choose") + "\n" + (codingContext.developmentSkill || "") },
    { role: "user", content: `CURRENT REQUEST (authoritative):\n${request}\n\nPROJECT INSTRUCTIONS (lower priority than current request):\n${codingContext.projectInstructions || "(none)"}\n\nPRIOR VERIFIED WORK:\n${codingContext.previousWork || "(none)"}\n\nRECENT CHAT (context only, not proof of file changes):\n${(codingContext.recentTurns ?? []).map((turn) => `${turn.role}: ${turn.content.slice(0, 500)}`).join("\n").slice(-3_000)}\n\nACTUAL FILES NOW:\n${entries.join("\n") || "(empty)"}\n\nFILE CONTENT:\n${context.join("\n\n")}` },
  ], common);
  let plan = parsePlan(planReply.content);
  for (const file of plan.files) inside(root, file.path);
  const needsWebEntry = !entries.includes("package.json") && /(\bapp\b|todo[\s-]*app|приложен|калькулятор|сайт|игр[уы]|website|web\s*app)/i.test(request);
  if (needsWebEntry && !plan.files.some((file) => extname(file.path).toLowerCase() === ".html")) {
    const revised = await complete(modelRef, [
      { role: "system", content: "Return ONLY JSON with files [{path,purpose}]. The project must be runnable by opening index.html. Include index.html and all files it references. Maximum 6 files. No prose." },
      { role: "user", content: `REQUEST: ${request}\nYour previous plan was not runnable: ${JSON.stringify(plan.files)}. Fix the plan.` },
    ], common);
    plan = parsePlan(revised.content);
    if (!plan.files.some((file) => extname(file.path).toLowerCase() === ".html")) {
      throw new Error("Модель не составила план запускаемого приложения");
    }
  }
  for (const file of plan.files) inside(root, file.path);
  const written: string[] = [];
  const generatedContext: string[] = [];
  for (const file of plan.files) {
    onStatus?.("working", `Создаю ${file.path}`);
    const target = inside(root, file.path);
    const existing = await readFile(target, "utf8").catch(() => "");
    if (existing.length > 12_000) throw new Error(`Файл слишком велик для безопасного редактирования: ${file.path}`);
    const result = await complete(modelRef, [
      { role: "system", content: "You are a coding agent. Return ONLY the complete contents of ONE requested file. No markdown fences, commentary, placeholders or truncated code. Implement working behavior. Preserve useful existing code. Avoid eval, unsafe innerHTML interpolation, and remote dependencies. Use textContent/createElement for user text. Stay consistent with the project.\n" + (codingContext.developmentSkill || "") },
      { role: "user", content: `USER REQUEST:\n${request}\n\nVERIFIED PREVIOUS WORK:\n${codingContext.previousWork || "(none)"}\n\nRECENT CHAT:\n${(codingContext.recentTurns ?? []).map((turn) => `${turn.role}: ${turn.content.slice(0, 400)}`).join("\n").slice(-2_000)}\n\nPROJECT FILES:\n${entries.join("\n") || "(empty)"}\n\nPLAN:\n${JSON.stringify(plan.files)}\n\nFILES ALREADY GENERATED (keep names and IDs consistent):\n${generatedContext.join("\n\n").slice(-16_000)}\n\nGENERATE FILE: ${file.path}\nPURPOSE: ${file.purpose}\n\nEXISTING CONTENT:\n${existing || "(new file)"}` },
    ], { ...common, maxTokens: 3000 });
    let content = unwrap(result.content);
    try {
      validateCodingFile(file.path, content);
    } catch (error) {
      const repair = await complete(modelRef, [
        { role: "system", content: "Return ONLY the complete corrected file. No markdown. Preserve requested behavior. Do not use eval or insert user text with innerHTML; use DOM textContent and createElement." },
        { role: "user", content: `REQUEST: ${request}\nFILE: ${file.path}\nVALIDATION ERROR: ${error instanceof Error ? error.message : String(error)}\nPREVIOUS CONTENT:\n${content.slice(0, 14_000)}\nRELATED FILES:\n${generatedContext.join("\n\n").slice(-10_000)}` },
      ], { ...common, maxTokens: 3000 });
      content = unwrap(repair.content);
      validateCodingFile(file.path, content);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    if ((await readFile(target, "utf8")) !== content) throw new Error(`Не удалось проверить запись: ${file.path}`);
    written.push(file.path);
    generatedContext.push(`${file.path}:\n${content.slice(0, 7000)}`);
  }
  const htmlFiles = written.filter((file) => extname(file).toLowerCase() === ".html");
  const jsFiles = written.filter((file) => [".js", ".cjs", ".mjs"].includes(extname(file).toLowerCase()));
  if (htmlFiles.length && jsFiles.length) {
    const html = (await Promise.all(htmlFiles.map((file) => readFile(inside(root, file), "utf8")))).join("\n");
    const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/gi)].map((match) => match[1]));
    for (const file of jsFiles) {
      const target = inside(root, file);
      let content = await readFile(target, "utf8");
      const missing = () => [...content.matchAll(/getElementById\(["']([^"']+)["']\)/g)]
        .map((match) => match[1]).filter((id) => !ids.has(id));
      if (missing().length) {
        onStatus?.("working", `Сверяю ${file} с HTML`);
        const repair = await complete(modelRef, [
          { role: "system", content: "Return ONLY the complete corrected JavaScript file. Use exactly the HTML element IDs provided. Keep all requested functionality. No markdown." },
          { role: "user", content: `REQUEST:\n${request}\n\nHTML:\n${html.slice(0, 10_000)}\n\nJAVASCRIPT FILE ${file}:\n${content}\n\nINVALID IDS: ${missing().join(", ")}` },
        ], { ...common, maxTokens: 3000 });
        const repaired = unwrap(repair.content);
        validateCodingFile(file, repaired);
        content = repaired;
        if (missing().length) throw new Error(`Несовпадение HTML и JavaScript: ${missing().join(", ")}`);
        await writeFile(target, content, "utf8");
        if ((await readFile(target, "utf8")) !== content) throw new Error(`Не удалось проверить запись: ${file}`);
      }
    }
  }
  const tools = written.length ? ["file.write", "file.read"] : [];
  let verification = "Файлы прочитаны после записи; синтаксис поддерживаемых форматов проверен.";
  const packagePath = resolve(root, "package.json");
  const packageText = await readFile(packagePath, "utf8").catch(() => "");
  if (packageText) {
    try {
      const pkg = JSON.parse(packageText) as { scripts?: Record<string, string> };
      const script = pkg.scripts?.test ? "test" : pkg.scripts?.build ? "build" : undefined;
      if (script) {
        onStatus?.("working", `Проверяю npm run ${script}`);
        const command = process.platform === "win32" ? "npm.cmd" : "npm";
        const output = await execFileAsync(command, ["run", script], { cwd: root, timeout: 60_000, maxBuffer: 1_000_000 });
        verification = `npm run ${script} выполнен успешно. ${output.stdout.slice(-500)}`;
        tools.push("shell.exec");
      }
    } catch (error) {
      return { response: `Изменены файлы: ${written.join(", ")}. Проверка не прошла: ${error instanceof Error ? error.message.slice(0, 700) : String(error)}. Задача требует исправления.`, tools, files: written };
    }
  }
  return { response: `Изменены файлы в ${root}: ${written.join(", ")}. ${verification}`, tools, files: written };
}
