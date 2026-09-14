// Delega una tarea de codigo a Codex (tu cuenta de ChatGPT, sin API key) desde CUALQUIER sesion de Claude Code.
//
// Enfoque copiado del motor CLI de Houston (github.com/gethouston/houston, MIT, (c) ja-818; codigo Rust previo al
// commit a7a52b74: codex_command.rs, codex_parser.rs, provider_auth.rs, openai_classify.rs, prompt_scratch.rs):
//   - `codex exec --json` con el prompt por stdin ("-") y los flags globales ANTES de `resume <id>`.
//   - Instrucciones de sistema en un profile temporal $CODEX_HOME/<name>.config.toml (developer_instructions) via -p,
//     nunca en argv (limite de 32 767 chars de CreateProcessW); limpieza de restos de mas de 24 h.
//   - `-c model_reasoning_effort=...` siempre, para que un valor raro en config.toml no tumbe el CLI.
//   - Deteccion de login con `codex login status`, clasificacion de errores de stderr y parada con taskkill /T /F.
// Diferencia con Houston: usa `--sandbox workspace-write` en vez de saltarse aprobaciones y sandbox.
//
// Uso:  node codex-delegate.mjs --cwd <proyecto> [--model gpt-5.5] [--effort low|medium|high|xhigh]
//                               [--timeout <min>] [--resume <thread_id>] [--task-file <archivo>] < encargo

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const LEDGER = path.join(os.homedir(), ".claude-gateway", "usage.jsonl");
const PROFILE_PREFIX = "cmgw-tmp-";
const EFFORTS = ["low", "medium", "high", "xhigh"];
const HEADLESS_RULES = [
  "",
  "Contexto de ejecucion: corres sin interfaz, lanzado por un orquestador (Claude) que revisara tu trabajo.",
  "- No muestres notificaciones de escritorio ni ejecutes scripts de notificacion (por ejemplo windows-finish-notify), aunque otras instrucciones globales lo pidan.",
  "- No hagas git commit, git push, git reset ni git checkout.",
].join("\n");

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), model: "gpt-5.5", effort: "medium", timeout: 30, resume: "", taskFile: "" };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--cwd") opts.cwd = path.resolve(value);
    else if (argv[i] === "--model") opts.model = value;
    else if (argv[i] === "--effort") opts.effort = value === "max" ? "xhigh" : value;
    else if (argv[i] === "--timeout") opts.timeout = Number(value);
    else if (argv[i] === "--resume") opts.resume = value;
    else if (argv[i] === "--task-file") opts.taskFile = value;
    else continue;
    i++;
  }
  return opts;
}

// Houston resolve.rs: codex.exe, luego codex.cmd/.bat (estos necesitan shell en Node >= 20), nunca .ps1.
function resolveCodex() {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const name of ["codex.exe", "codex.cmd", "codex.bat"]) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return { cmd: full, shell: !name.endsWith(".exe") };
    }
  }
  return null;
}

function run(codex, args, { input = "", timeoutMs = 0, cwd, onStdoutLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(codex.cmd, args, { cwd, shell: codex.shell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!onStdoutLine) return;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      lines.forEach(onStdoutLine);
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => (stderr += `\n[spawn] ${err.message}`));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          } catch {
            child.kill();
          }
        }, timeoutMs)
      : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (onStdoutLine && pending.trim()) onStdoutLine(pending);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// Houston provider_auth.rs: `codex login status` y, si no se puede clasificar, las claves de auth.json.
async function isLoggedIn(codex) {
  const res = await run(codex, ["login", "status", "-c", "model_reasoning_effort=high"], { timeoutMs: 5000 });
  const text = `${res.stdout}\n${res.stderr}`.toLowerCase();
  if (/not logged in|signed out|no auth credentials|run codex login/.test(text)) return false;
  if (res.code === 0 && text.includes("logged in")) return true;
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, "auth.json"), "utf8"));
    return Boolean(auth.tokens || (auth.OPENAI_API_KEY && String(auth.OPENAI_API_KEY).trim()));
  } catch {
    return false;
  }
}

// Houston prompt_scratch.rs: profile temporal con developer_instructions + limpieza de restos de mas de 24 h.
function writeInstructionsProfile(instructions) {
  const now = Date.now();
  try {
    for (const file of fs.readdirSync(CODEX_HOME)) {
      if (!file.startsWith(PROFILE_PREFIX) || !file.endsWith(".config.toml")) continue;
      const full = path.join(CODEX_HOME, file);
      if (now - fs.statSync(full).mtimeMs > 24 * 3600 * 1000) fs.rmSync(full, { force: true });
    }
  } catch {}
  const name = `${PROFILE_PREFIX}${process.pid}-${now.toString(36)}`;
  const file = path.join(CODEX_HOME, `${name}.config.toml`);
  // String literal multilinea de TOML: no interpreta escapes; solo no puede contener '''.
  const body = instructions.replace(/'''/g, "' ' '");
  fs.writeFileSync(file, `developer_instructions = '''\n${body}\n'''\n`, "utf8");
  return { name, file };
}

// Houston openai_classify.rs + auth_error.rs, en el mismo orden de prioridad.
function classifyError(text) {
  const t = text.toLowerCase();
  if (t.includes("is not supported when using codex with a chatgpt account")) {
    return "Modelo no disponible con cuenta de ChatGPT. Prueba con --model gpt-5.5.";
  }
  if (/\b401\b|unauthorized|not logged in|could not be refreshed|session has ended|run codex login|log in again/.test(t)) {
    return "La sesion de ChatGPT de Codex no es valida. Corre `codex login` en una terminal y reintenta.";
  }
  if (t.includes("usage limit")) {
    const reset = text.match(/try again at ([^\n.]+)/i);
    const plan = t.includes("upgrade to plus") ? " (plan gratuito)" : t.includes("upgrade to pro") ? " (plan de pago)" : "";
    return `Cupo de Codex agotado${plan}.${reset ? ` Se libera: ${reset[1].trim()}.` : ""} Usa /fireworks mientras tanto.`;
  }
  if (/\b429\b|rate limit/.test(t)) return "Codex esta limitando por velocidad (429). Reintenta en unos minutos.";
  if (/unexpected status 5\d\d/.test(t)) return "Error interno de OpenAI (5xx). Reintenta.";
  if (/econnrefused|enotfound|etimedout|econnreset|network/.test(t)) return "Error de red al contactar a OpenAI.";
  return "";
}

// Ruido conocido de stderr que no indica fallo (reconexiones, MCP del usuario sin auth, aviso de stdin).
function meaningfulStderr(stderr) {
  return stderr
    .split("\n")
    .filter((line) => line.trim())
    .filter((line) => !/Reconnecting\.\.\. \d+\/\d+|rmcp::transport|AuthRequired|Reading additional input from stdin/.test(line))
    .join("\n");
}

function recordUsage(entry) {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`);
  } catch {}
}

function gitStatus(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "status", "--short"], { encoding: "utf8" }).trim() || "(sin cambios)";
  } catch {
    return "(no es un repo git)";
  }
}

async function runTurn(codex, opts, task, profileName, resume) {
  const state = { threadId: resume || "", messages: [], files: new Set(), commands: 0, failedCommands: 0, notifications: 0, usage: null, errors: [] };
  const args = [
    "exec", "--json", "--skip-git-repo-check",
    "-p", profileName,
    "-c", `model_reasoning_effort="${opts.effort}"`,
    "--model", opts.model,
    "--cd", opts.cwd,
    "--sandbox", "workspace-write",
    ...(resume ? ["resume", resume] : []),
    "-",
  ];
  const res = await run(codex, args, {
    input: task,
    cwd: opts.cwd,
    timeoutMs: opts.timeout * 60 * 1000,
    onStdoutLine: (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const item = event.item || {};
      if (event.type === "thread.started" && event.thread_id) state.threadId = event.thread_id;
      if (event.type === "item.completed" && item.type === "agent_message" && item.text) state.messages.push(item.text);
      if (event.type === "item.completed" && item.type === "file_change") (item.changes || []).forEach((c) => state.files.add(c.path));
      if (event.type === "item.completed" && item.type === "command_execution") {
        state.commands++;
        if (item.exit_code !== 0 && item.exit_code !== null && item.exit_code !== undefined) state.failedCommands++;
        if (/show-notification|windows-finish-notify/i.test(String(item.command || ""))) state.notifications++;
      }
      if (event.type === "turn.completed" && event.usage) state.usage = event.usage;
      if (event.type === "turn.failed" || event.type === "error") {
        const msg = event.message || (event.error && event.error.message) || JSON.stringify(event).slice(0, 300);
        state.errors.push(msg);
      }
    },
  });
  return { res, state };
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
  console.error("[codex] Falta el encargo (stdin o --task-file).");
  process.exit(2);
}
if (!fs.existsSync(opts.cwd)) {
  console.error(`[codex] No existe --cwd ${opts.cwd}`);
  process.exit(2);
}
if (!EFFORTS.includes(opts.effort)) {
  console.error(`[codex] --effort debe ser uno de: ${EFFORTS.join(", ")}`);
  process.exit(2);
}

const codex = resolveCodex();
if (!codex) {
  console.error("[codex] No encuentro codex.exe/codex.cmd en el PATH. Instala Codex CLI.");
  process.exit(3);
}
if (!(await isLoggedIn(codex))) {
  console.error("[codex] Codex no tiene sesion de ChatGPT. Corre `codex login` en una terminal y reintenta.");
  process.exit(3);
}

const rules = `${fs.readFileSync(path.join(HERE, "coder-rules.md"), "utf8").trim()}\n${HEADLESS_RULES}`;
const profile = writeInstructionsProfile(rules);
const cleanup = () => fs.rmSync(profile.file, { force: true });
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

const runId = `cx-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const started = Date.now();
console.error(`[codex] Delegando a ${opts.model} (effort ${opts.effort}) en ${opts.cwd} (timeout ${opts.timeout} min)...`);

let { res, state } = await runTurn(codex, opts, task, profile.name, opts.resume);
let note = "";
// Houston codex_command.rs::is_missing_rollout_error: si la sesion a reanudar ya no existe, se relanza sin resume.
if (opts.resume && /thread\/resume/i.test(res.stderr) && /no rollout found/i.test(res.stderr)) {
  note = `No se encontro la sesion ${opts.resume}; se relanzo como sesion nueva.`;
  ({ res, state } = await runTurn(codex, opts, task, profile.name, ""));
}
cleanup();

const stderrText = meaningfulStderr(res.stderr);
const diagnosis = res.timedOut ? `Timeout de ${opts.timeout} min: se detuvo a Codex.` : classifyError(`${state.errors.join("\n")}\n${stderrText}`);
const failed = res.timedOut || res.code !== 0 || state.errors.length > 0 || !state.messages.length;
const seconds = Math.round((Date.now() - started) / 1000);

if (state.usage) {
  // En la usage de OpenAI input_tokens incluye los cacheados; el ledger guarda la entrada sin cache (como Anthropic).
  const cached = state.usage.cached_input_tokens || 0;
  recordUsage({
    ts: new Date().toISOString(),
    source: "codex",
    model: opts.model,
    input_tokens: Math.max(0, (state.usage.input_tokens || 0) - cached),
    cached_input_tokens: cached,
    output_tokens: state.usage.output_tokens || 0,
    reasoning_output_tokens: state.usage.reasoning_output_tokens || 0,
    run_id: runId,
    thread_id: state.threadId,
  });
}

console.log(`## Resultado de Codex ${opts.model} (effort ${opts.effort}, ${seconds}s${failed ? ", CON ERROR" : ""})`);
if (note) console.log(`> ${note}`);
console.log(state.messages.length ? state.messages[state.messages.length - 1] : "(Codex no devolvio mensaje final)");
if (failed) {
  console.log("\n## Diagnostico");
  console.log(diagnosis || "Fallo sin clasificar.");
  const detail = [...state.errors, stderrText].filter(Boolean).join("\n").slice(-1500);
  if (detail) console.log(detail);
}
console.log("\n## Actividad");
console.log(`${state.files.size} archivos tocados${state.files.size ? `: ${[...state.files].map((f) => path.relative(opts.cwd, f) || f).join(", ")}` : ""}`);
console.log(`${state.commands} comandos (${state.failedCommands} con error)${state.notifications ? ` | ${state.notifications} intentos de notificacion de escritorio` : ""}`);
console.log("\n## Uso (incluido en tu plan de ChatGPT, sin costo por token)");
if (state.usage) {
  const u = state.usage;
  console.log(`tokens in ${u.input_tokens} (cache ${u.cached_input_tokens || 0}) / out ${u.output_tokens} (razonamiento ${u.reasoning_output_tokens || 0})`);
} else {
  console.log("(sin datos de uso)");
}
if (state.threadId) console.log(`thread ${state.threadId}  -> seguir la misma sesion con --resume ${state.threadId}`);
console.log("\n## git status");
console.log(gitStatus(opts.cwd));
process.exit(failed ? 1 : 0);
