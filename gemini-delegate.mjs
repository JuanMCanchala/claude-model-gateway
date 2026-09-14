// Delega una tarea de codigo a Gemini CLI (tu cuenta de Google o GEMINI_API_KEY) desde CUALQUIER sesion de Claude Code.
//
// Enfoque copiado del motor CLI de Houston (github.com/gethouston/houston, MIT, (c) ja-818; codigo Rust previo al
// commit a7a52b74: gemini_runner.rs, gemini_home.rs, gemini_parser*.rs, provider/gemini/{mod,classify}.rs):
//   - `gemini --output-format stream-json --yolo --skip-trust [--model] [--include-directories <cwd>] [--resume]`
//     con el prompt por stdin.
//   - Instrucciones de sistema envueltas en <system>...</system> delante del prompt (el CLI no tiene flag de system).
//   - HOME/USERPROFILE apuntando a un home aislado con SOLO las credenciales (oauth_creds.json, google_accounts.json,
//     .env; symlink o copia) y un settings.json minimo: no se cuelan el GEMINI.md global ni tus MCP.
//   - Sonda de auth ANTES de lanzar (sin login, el CLI pregunta por stdin y se come el encargo).
//   - Clasificacion de errores por result.error.type y por las lineas "Attempt N failed" de stderr.
// Diferencias con Houston: politica --policy (gemini-policy.toml) que niega git push/commit/reset, borrados recursivos
// y publicar; lanza el bundle JS con node en vez del shim .cmd; registra tokens en el ledger.
//
// Uso:  node gemini-delegate.mjs --cwd <proyecto> [--model <id>] [--timeout <min>] [--resume latest|<n>]
//                                [--task-file <archivo>] < encargo

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_GEMINI = path.join(os.homedir(), ".gemini");
const RUNTIME_HOME = path.join(os.homedir(), ".claude-gateway", "gemini-home");
const LEDGER = path.join(os.homedir(), ".claude-gateway", "usage.jsonl");
const CREDENTIAL_FILES = ["oauth_creds.json", "google_accounts.json", ".env"];
const HEADLESS_RULES = [
  "",
  "Contexto de ejecucion: corres sin interfaz, lanzado por un orquestador (Claude) que revisara tu trabajo.",
  "- Trabaja solo dentro del directorio del proyecto.",
  "- No hagas git commit, git push, git reset ni git checkout (estan bloqueados por politica).",
].join("\n");

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), model: "", timeout: 30, resume: "", taskFile: "" };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--cwd") opts.cwd = path.resolve(value);
    else if (argv[i] === "--model") opts.model = value;
    else if (argv[i] === "--timeout") opts.timeout = Number(value);
    else if (argv[i] === "--resume") opts.resume = value;
    else if (argv[i] === "--task-file") opts.taskFile = value;
    else continue;
    i++;
  }
  return opts;
}

// Houston resolve: bundle preferido; aqui el bundle JS del paquete npm (evita el shim .cmd, que en Node >= 20 exige shell).
function resolveGemini() {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(dir, "gemini.cmd")) && !fs.existsSync(path.join(dir, "gemini"))) continue;
    const bundle = path.join(dir, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
    if (fs.existsSync(bundle)) return { cmd: process.execPath, prefix: [bundle], shell: false };
    if (fs.existsSync(path.join(dir, "gemini.cmd"))) return { cmd: path.join(dir, "gemini.cmd"), prefix: [], shell: true };
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Houston provider/gemini/mod.rs::probe_auth. Devuelve { ok, selectedType, reason }.
function probeAuth() {
  const envKey = [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY].some((v) => v && v.trim());
  if (envKey) return { ok: true, selectedType: "gemini-api-key" };
  try {
    const dotenv = fs.readFileSync(path.join(REAL_GEMINI, ".env"), "utf8");
    if (/^(?:export\s+)?GEMINI_API_KEY=\S+/m.test(dotenv)) return { ok: true, selectedType: "gemini-api-key" };
  } catch {}
  const settings = readJson(path.join(REAL_GEMINI, "settings.json"));
  const selected = settings?.security?.auth?.selectedType || "";
  if (selected === "gemini-api-key") return { ok: false, reason: "settings pide API key pero no hay GEMINI_API_KEY" };
  const accounts = readJson(path.join(REAL_GEMINI, "google_accounts.json"));
  const active = accounts && typeof accounts.active === "string" && accounts.active.trim();
  const creds = fs.existsSync(path.join(REAL_GEMINI, "oauth_creds.json"));
  if (active && creds) return { ok: true, selectedType: selected || "oauth-personal" };
  return { ok: false, reason: "no hay login de Google (falta oauth_creds.json o cuenta activa)" };
}

// Houston gemini_home.rs: home aislado con solo credenciales + settings minimo. Symlink y, si Windows lo niega, copia.
function ensureRuntimeHome(selectedType) {
  const dotGemini = path.join(RUNTIME_HOME, ".gemini");
  fs.mkdirSync(dotGemini, { recursive: true });
  for (const name of CREDENTIAL_FILES) {
    const source = path.join(REAL_GEMINI, name);
    const target = path.join(dotGemini, name);
    fs.rmSync(target, { force: true });
    if (!fs.existsSync(source)) continue;
    try {
      fs.symlinkSync(source, target, "file");
    } catch {
      fs.copyFileSync(source, target);
    }
  }
  const settings = { security: { auth: { selectedType } } };
  fs.writeFileSync(path.join(dotGemini, "settings.json"), JSON.stringify(settings));
  fs.rmSync(path.join(dotGemini, "GEMINI.md"), { force: true });
  return RUNTIME_HOME;
}

// Houston provider/gemini/classify.rs: primero el result.error.type, luego patrones de stderr.
function classifyError(errorType, message, stderr) {
  const status = (message.match(/\b([1-5]\d\d)\b/) || [])[1];
  if (errorType === "FatalAuthenticationError" || /FatalCancellationError|Opening authentication page/.test(stderr)) {
    return "Gemini no tiene una sesion valida. Corre `gemini` en una terminal y elige Sign in with Google.";
  }
  if (errorType === "RetryableQuotaError" || /Max attempts reached/i.test(stderr)) {
    return "Cupo de Gemini agotado para este modelo. Prueba mas tarde, otro --model o /codex / /fireworks.";
  }
  if (errorType === "GaxiosError") {
    if (status === "401" || status === "403") return "Gemini rechazo las credenciales (401/403). Vuelve a iniciar sesion con `gemini`.";
    if (status === "429") return "Gemini esta limitando por velocidad (429). Reintenta en unos minutos.";
    if (status && status.startsWith("5")) return `Error interno de Google (${status}). Reintenta.`;
    if (/network|dns|connect/i.test(message)) return "Error de red al contactar a la API de Gemini.";
    return "Error HTTP de la API de Gemini.";
  }
  if (errorType === "MaxSessionTurnsError") return "Gemini alcanzo su limite de turnos de sesion.";
  const retry = stderr.match(/Retrying after (\d+)ms/);
  if (retry) return `Gemini esta limitando por cupo; reintentaba en ~${Math.round(Number(retry[1]) / 1000)} s.`;
  if (/\b401\b/.test(stderr) && /unauthori[sz]ed|auth/i.test(stderr)) return "Gemini rechazo las credenciales (401).";
  if (/api key/i.test(stderr) && /invalid|missing|no api key/i.test(stderr)) return "Problema con la API key de Gemini.";
  return "";
}

function meaningfulStderr(stderr) {
  return stderr
    .split("\n")
    .filter((line) => line.trim())
    .filter((line) => !/True color|YOLO mode is enabled|Loaded cached credentials|Skipping trust/i.test(line))
    .join("\n");
}

function gitStatus(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "status", "--short"], { encoding: "utf8" }).trim() || "(sin cambios)";
  } catch {
    return "(no es un repo git)";
  }
}

// ---------------------------------------------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const task = (opts.taskFile ? fs.readFileSync(opts.taskFile, "utf8") : await new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve("");
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (data += c));
  process.stdin.on("end", () => resolve(data));
})).trim();

if (!task) {
  console.error("[gemini] Falta el encargo (stdin o --task-file).");
  process.exit(2);
}
if (!fs.existsSync(opts.cwd)) {
  console.error(`[gemini] No existe --cwd ${opts.cwd}`);
  process.exit(2);
}
const gemini = resolveGemini();
if (!gemini) {
  console.error("[gemini] No encuentro Gemini CLI. Instala con: npm install -g @google/gemini-cli");
  process.exit(3);
}
const auth = probeAuth();
if (!auth.ok) {
  console.error(`[gemini] Sin autenticacion: ${auth.reason}. Corre \`gemini\` en una terminal y elige Sign in with Google.`);
  process.exit(3);
}

const home = ensureRuntimeHome(auth.selectedType);
const rules = `${fs.readFileSync(path.join(HERE, "coder-rules.md"), "utf8").trim()}\n${HEADLESS_RULES}`;
// Houston gemini_runner.rs::compose_gemini_prompt.
const prompt = `<system>\n${rules}\n</system>\n\n${task}`;
const args = [
  ...gemini.prefix,
  "-p", "",
  "--output-format", "stream-json",
  "--yolo",
  "--skip-trust",
  "--policy", path.join(HERE, "gemini-policy.toml"),
  "--include-directories", opts.cwd,
  ...(opts.model ? ["--model", opts.model] : []),
  ...(opts.resume ? ["--resume", opts.resume] : []),
];

const runId = `gm-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const started = Date.now();
console.error(`[gemini] Delegando a Gemini${opts.model ? ` ${opts.model}` : ""} en ${opts.cwd} (timeout ${opts.timeout} min)...`);

const state = { sessionId: "", model: opts.model, buffer: "", blocks: [], files: new Set(), commands: 0, failedTools: 0, denied: 0, warnings: [], result: null };
const flush = () => {
  if (state.buffer.trim()) state.blocks.push(state.buffer);
  state.buffer = "";
};
const handleEvent = (event) => {
  const params = event.parameters || {};
  switch (event.type) {
    case "init":
      state.sessionId = event.session_id || state.sessionId;
      state.model = event.model || state.model;
      break;
    case "message":
      if (event.role !== "assistant" || !event.content) break;
      if (event.delta) state.buffer += event.content;
      else {
        flush();
        state.blocks.push(event.content);
      }
      break;
    case "tool_use":
      flush();
      if (event.tool_name === "run_shell_command") state.commands++;
      if (params.file_path && /write|replace|edit/i.test(event.tool_name)) state.files.add(params.file_path);
      break;
    case "tool_result":
      flush();
      if (event.status === "error") {
        state.failedTools++;
        if (/denied|policy/i.test(JSON.stringify(event.error || ""))) state.denied++;
      }
      break;
    case "error":
      flush();
      state.warnings.push(event.message);
      break;
    case "result":
      flush();
      state.result = event;
      break;
  }
};

const child = spawn(gemini.cmd, args, {
  cwd: opts.cwd,
  shell: gemini.shell,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, HOME: home, USERPROFILE: home },
});
let stderr = "";
let pending = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  pending += chunk;
  const lines = pending.split("\n");
  pending = lines.pop();
  for (const line of lines) {
    try {
      handleEvent(JSON.parse(line));
    } catch {}
  }
});
child.stderr.on("data", (chunk) => (stderr += chunk));
child.on("error", (err) => (stderr += `\n[spawn] ${err.message}`));
child.stdin.on("error", () => {});
child.stdin.end(prompt);

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    child.kill();
  }
}, opts.timeout * 60 * 1000);
const exitCode = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(timer);
if (pending.trim()) {
  try {
    handleEvent(JSON.parse(pending));
  } catch {}
}
flush();

const result = state.result;
const stats = result?.stats || null;
const resultError = result?.error || null;
const stderrText = meaningfulStderr(stderr);
const failed = timedOut || exitCode !== 0 || !result || result.status === "error";
const diagnosis = timedOut
  ? `Timeout de ${opts.timeout} min: se detuvo a Gemini.`
  : exitCode === 53
    ? "Gemini alcanzo el limite de turnos (exit 53)."
    : classifyError(resultError?.type || "", resultError?.message || "", stderrText);
const seconds = Math.round((Date.now() - started) / 1000);
const modelUsed = state.model || Object.keys(stats?.models || {})[0] || "gemini";

if (stats) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const cached = stats.cached || 0;
  fs.appendFileSync(
    LEDGER,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      source: "gemini",
      model: modelUsed,
      input_tokens: stats.input ?? Math.max(0, (stats.input_tokens || 0) - cached),
      cached_input_tokens: cached,
      output_tokens: stats.output_tokens || 0,
      run_id: runId,
      session_id: state.sessionId,
    })}\n`,
  );
}

console.log(`## Resultado de Gemini ${modelUsed} (${seconds}s${failed ? ", CON ERROR" : ""})`);
console.log(state.blocks.length ? state.blocks[state.blocks.length - 1] : "(Gemini no devolvio mensaje final)");
if (failed) {
  console.log("\n## Diagnostico");
  console.log(diagnosis || "Fallo sin clasificar.");
  const detail = [resultError ? `${resultError.type}: ${resultError.message}` : "", ...state.warnings, stderrText].filter(Boolean).join("\n").slice(-1500);
  if (detail) console.log(detail);
}
console.log("\n## Actividad");
console.log(`${state.files.size} archivos escritos${state.files.size ? `: ${[...state.files].map((f) => path.relative(opts.cwd, f) || f).join(", ")}` : ""}`);
console.log(`${state.commands} comandos | ${state.failedTools} herramientas con error${state.denied ? ` (${state.denied} bloqueadas por politica)` : ""}`);
console.log("\n## Uso");
console.log(stats ? `tokens in ${stats.input_tokens} (cache ${stats.cached || 0}) / out ${stats.output_tokens} | ${stats.tool_calls ?? 0} tool calls` : "(sin datos de uso)");
if (state.sessionId) console.log(`sesion ${state.sessionId}  -> seguir la ultima sesion de este proyecto con --resume latest`);
console.log("\n## git status");
console.log(gitStatus(opts.cwd));
process.exit(failed ? 1 : 0);
