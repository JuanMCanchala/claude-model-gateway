// Delega una tarea de codigo a DeepSeek (Fireworks) desde CUALQUIER sesion de Claude Code, sin cambiar de sesion.
// Lanza un Claude Code headless cuyo modelo es DeepSeek, via el gateway local :4141.
// El hijo corre sin hooks ni MCP (no consume cupo de Claude) y no puede commitear ni pushear.
//
// Uso:  node fw-delegate.mjs --cwd <proyecto> [--timeout <min>] [--model <id>] [--task-file <archivo>] < encargo
//       (el encargo va por stdin o en --task-file)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = "http://127.0.0.1:4141";
const LEDGER = path.join(os.homedir(), ".claude-gateway", "usage.jsonl");

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), timeout: 30, model: "deepseek-v4p1-flash", taskFile: "" };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--cwd") opts.cwd = path.resolve(value);
    else if (argv[i] === "--timeout") opts.timeout = Number(value);
    else if (argv[i] === "--model") opts.model = value;
    else if (argv[i] === "--task-file") opts.taskFile = value;
    else continue;
    i++;
  }
  return opts;
}

async function gatewayHealth() {
  try {
    const res = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function ensureGateway() {
  const health = await gatewayHealth();
  if (health) return health;
  try {
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "claude-gateway.ps1"), "start"], { stdio: "ignore" });
  } catch {}
  return gatewayHealth();
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

function usageSince(startIso) {
  const prices = JSON.parse(fs.readFileSync(path.join(HERE, "prices.json"), "utf8"));
  const total = { calls: 0, input: 0, cached: 0, output: 0, usd: 0 };
  if (!fs.existsSync(LEDGER)) return total;
  for (const line of fs.readFileSync(LEDGER, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.source !== "coder" || entry.ts < startIso) continue;
    const p = prices[entry.model] || { input: 0, cached_input: 0, output: 0 };
    total.calls++;
    total.input += entry.input_tokens;
    total.cached += entry.cached_input_tokens;
    total.output += entry.output_tokens;
    total.usd += (entry.input_tokens * p.input + entry.cached_input_tokens * p.cached_input + entry.output_tokens * p.output) / 1e6;
  }
  return total;
}

function parseResult(stdout) {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {}
  const at = text.lastIndexOf('{"type":"result"');
  if (at >= 0) {
    try {
      return JSON.parse(text.slice(at));
    } catch {}
  }
  return null;
}

function gitStatus(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "status", "--short"], { encoding: "utf8" }).trim() || "(sin cambios)";
  } catch {
    return "(no es un repo git)";
  }
}

const opts = parseArgs(process.argv.slice(2));
const task = (opts.taskFile ? fs.readFileSync(opts.taskFile, "utf8") : await readStdin()).trim();
if (!task) {
  console.error("[fw] Falta el encargo (stdin o --task-file).");
  process.exit(2);
}
if (!fs.existsSync(opts.cwd)) {
  console.error(`[fw] No existe --cwd ${opts.cwd}`);
  process.exit(2);
}

const health = await ensureGateway();
if (!health || !health.fireworksKey) {
  console.error("[fw] Gateway apagado o sin key de Fireworks. Revisa: claude-gateway status / claude-keys");
  process.exit(3);
}

const model = opts.model;
const startIso = new Date().toISOString();
const started = Date.now();
const args = [
  "-p",
  "--output-format", "json",
  "--model", model,
  "--permission-mode", "acceptEdits",
  "--allowedTools", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash",
  "--disallowedTools", "Bash(git push:*)", "Bash(git commit:*)", "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(rm -rf:*)", "Agent", "WebFetch", "WebSearch",
  "--strict-mcp-config",
  "--settings", JSON.stringify({ disableAllHooks: true }),
  "--append-system-prompt-file", path.join(HERE, "coder-rules.md"),
];
// Todo el trafico del hijo (incluidos los modelos "rapidos" internos) va a Fireworks.
const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: GATEWAY,
  ENABLE_TOOL_SEARCH: "true",
  ANTHROPIC_DEFAULT_OPUS_MODEL: model,
  ANTHROPIC_DEFAULT_SONNET_MODEL: model,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
  ANTHROPIC_SMALL_FAST_MODEL: model,
  CLAUDE_CODE_SUBAGENT_MODEL: model,
};

console.error(`[fw] Delegando a ${model} en ${opts.cwd} (timeout ${opts.timeout} min)...`);
const child = spawn("claude", args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let stdout = "";
let stderr = "";
child.stdout.on("data", (c) => (stdout += c));
child.stderr.on("data", (c) => (stderr += c));
child.stdin.end(task);

const timer = setTimeout(() => {
  console.error(`[fw] Timeout de ${opts.timeout} min: deteniendo al coder.`);
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    child.kill();
  }
}, opts.timeout * 60 * 1000);

const exitCode = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(timer);

const result = parseResult(stdout);
const usage = usageSince(startIso);
const seconds = Math.round((Date.now() - started) / 1000);
const failed = !result || result.is_error || exitCode !== 0;

console.log(`## Resultado de ${model} (${seconds}s${result ? `, ${result.num_turns} turnos` : ""}${failed ? ", CON ERROR" : ""})`);
console.log(result && result.result ? result.result : `(sin resultado parseable; exit=${exitCode})\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`);
console.log("\n## Consumo en Fireworks");
console.log(`${usage.calls} llamadas | tokens in ${usage.input} / cache ${usage.cached} / out ${usage.output} | USD ${usage.usd.toFixed(4)}`);
console.log("\n## git status");
console.log(gitStatus(opts.cwd));
process.exit(failed ? 1 : 0);
