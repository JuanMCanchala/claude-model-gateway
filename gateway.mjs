// Gateway local para Claude Code: enruta cada request segun el modelo.
//   model deepseek-* (o accounts/fireworks/...) -> Fireworks (endpoint Anthropic nativo) con la key de Fireworks
//   cualquier otro                              -> https://api.anthropic.com (passthrough intacto, tu sesion de Claude)
// Cada llamada a Fireworks deja su consumo en ~/.claude-gateway/usage.jsonl (source=coder), tambien si se corta.
// Prefijo opcional /run/<id> en la ruta (ANTHROPIC_BASE_URL=http://127.0.0.1:4141/run/<id>): etiqueta el consumo
// con run_id para atribuir el costo exacto a cada delegacion aunque corran en paralelo.
// Sin dependencias. Solo escucha en 127.0.0.1.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.GATEWAY_PORT || 4141);
const ANTHROPIC_URL = "https://api.anthropic.com";
const FIREWORKS_URL = "https://api.fireworks.ai/inference";
const CODER_MODEL = /^(deepseek|accounts\/fireworks\/)/i;
// Alias cortos que usan los agentes -> ids de Fireworks. Cualquier otro deepseek-* se prefija tal cual.
const FIREWORKS_MODELS = {
  "deepseek-v4p1-flash": "accounts/fireworks/models/deepseek-v4p1-flash",
  "deepseek-flash": "accounts/fireworks/models/deepseek-v4p1-flash",
  "deepseek-v4-pro": "accounts/fireworks/models/deepseek-v4-pro",
};
// Tope de tokens de razonamiento por llamada al coder (0 = sin tope). Medido: 4000 baja ~30% costo y ~40% tiempo.
const THINKING_BUDGET = Number(process.env.CODER_THINKING_BUDGET ?? 4000);
const STATE_DIR = path.join(os.homedir(), ".claude-gateway");
const LOG_FILE = path.join(STATE_DIR, "gateway.log");
const USAGE_FILE = path.join(STATE_DIR, "usage.jsonl");

// Campos del Messages API que no conviene mandar a un proveedor que no es Anthropic.
const UNSUPPORTED_TOP_LEVEL = ["container", "mcp_servers", "service_tier", "top_k", "context_management"];
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"];
const USAGE_FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens"];

const agent = new https.Agent({ keepAlive: true });

fs.mkdirSync(STATE_DIR, { recursive: true });
try {
  if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.truncateSync(LOG_FILE, 0);
} catch {}

function log(line) {
  fs.appendFile(LOG_FILE, `${new Date().toISOString()} ${line}\n`, () => {});
}

// La key llega por la variable FIREWORKS_API_KEY (claude-gateway.ps1 la inyecta desde la variable de usuario).
function fireworksKey() {
  return process.env.FIREWORKS_API_KEY || "";
}

function resolveFireworksModel(model) {
  if (model.toLowerCase().startsWith("accounts/")) return model;
  return FIREWORKS_MODELS[model.toLowerCase()] || `accounts/fireworks/models/${model}`;
}

function mergeUsage(total, usage) {
  if (!usage) return;
  for (const field of USAGE_FIELDS) total[field] = Math.max(total[field] || 0, usage[field] || 0);
}

// Extrae el consumo tanto de respuestas JSON como de streams SSE
// (message_start trae el usage inicial y message_delta el final).
function extractUsage(contentType, text) {
  const total = {};
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === "message_start") mergeUsage(total, event.message && event.message.usage);
        if (event.type === "message_delta") mergeUsage(total, event.usage);
      } catch {}
    }
  } else {
    try {
      mergeUsage(total, JSON.parse(text).usage);
    } catch {}
  }
  return total;
}

// Tokens generados en un stream cortado antes del usage final: caracteres de los deltas / 4.
function estimateStreamedTokens(text) {
  let chars = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const delta = JSON.parse(line.slice(6)).delta;
      if (delta) chars += (delta.text || delta.thinking || delta.partial_json || "").length;
    } catch {}
  }
  return Math.ceil(chars / 4);
}

function recordUsage(model, usage, runId, aborted, estimated) {
  const entry = {
    ts: new Date().toISOString(),
    source: "coder",
    model,
    input_tokens: usage.input_tokens || 0,
    cached_input_tokens: usage.cache_read_input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
  };
  if (runId) entry.run_id = runId;
  if (aborted) entry.aborted = true;
  if (estimated) entry.estimated = true;
  if (!entry.input_tokens && !entry.output_tokens && !entry.cached_input_tokens) return;
  fs.appendFile(USAGE_FILE, `${JSON.stringify(entry)}\n`, () => {});
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(buf) {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

function stripCacheControl(node) {
  if (Array.isArray(node)) {
    node.forEach(stripCacheControl);
  } else if (node && typeof node === "object") {
    delete node.cache_control;
    Object.values(node).forEach(stripCacheControl);
  }
}

function sanitizeForCoder(body) {
  for (const key of UNSUPPORTED_TOP_LEVEL) delete body[key];
  stripCacheControl(body);
  // Solo herramientas definidas por el cliente; las server tools (web_search, code_execution...) no existen alli.
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.filter((t) => !t.type || t.type === "custom");
    if (body.tools.length === 0) {
      delete body.tools;
      delete body.tool_choice;
    }
  }
  // Tope de razonamiento: sin tope, DeepSeek llegó a gastar los 32k de max_tokens pensando sin escribir nada.
  // adaptive/enabled -> enabled con budget <= THINKING_BUDGET (Fireworks exige budget_tokens < max_tokens).
  // CODER_THINKING_BUDGET=0 quita el tope: adaptive pasa tal cual y enabled sin budget recibe hasta 16000.
  if (body.thinking && body.thinking.type !== "disabled" && !(body.thinking.type === "adaptive" && THINKING_BUDGET <= 0)) {
    const limit = THINKING_BUDGET > 0 ? THINKING_BUDGET : 16000;
    const asked = body.thinking.type === "enabled" ? Number(body.thinking.budget_tokens) || limit : limit;
    const budget = Math.min(asked, limit, (Number(body.max_tokens) || 0) - 1);
    body.thinking = budget >= 1024 ? { type: "enabled", budget_tokens: budget } : { type: "disabled" };
  }
  body.model = resolveFireworksModel(body.model);
  return body;
}

function sendError(res, status, message) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `[gateway] ${message}` } }));
}

function forward(req, res, { url, headers, body, label, started, onComplete }) {
  const upstream = https.request(
    url,
    { method: req.method, headers: { ...headers, host: url.host, "content-length": body.length }, agent },
    (up) => {
      const outHeaders = { ...up.headers };
      for (const h of HOP_BY_HOP) delete outHeaders[h];
      res.writeHead(up.statusCode || 502, outHeaders);
      const captured = [];
      let ended = false;
      if (onComplete) up.on("data", (chunk) => captured.push(chunk));
      up.pipe(res);
      const complete = (aborted) => {
        if (onComplete) onComplete(up.statusCode, String(up.headers["content-type"] || ""), Buffer.concat(captured).toString("utf8"), aborted);
      };
      up.on("end", () => {
        ended = true;
        log(`${label} ${req.method} ${req.url} -> ${up.statusCode} ${Date.now() - started}ms`);
        complete(false);
      });
      // Si el cliente corta o se cae la conexion, lo ya consumido (al menos el input de message_start) igual se registra.
      // Al destruir la peticion (cliente que corta) la respuesta emite "error"; sin este handler tumbaria el proceso.
      up.on("error", () => {});
      up.on("close", () => {
        if (ended) return;
        log(`${label} ${req.method} ${req.url} -> ${up.statusCode} CORTADO ${Date.now() - started}ms`);
        complete(true);
      });
    },
  );
  upstream.on("error", (err) => {
    log(`${label} ${req.method} ${req.url} -> ERROR ${err.message}`);
    sendError(res, 502, `upstream ${label}: ${err.message}`);
  });
  // req "close" ya se emitio al terminar de leer el body; la desconexion del cliente se detecta en res.
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
  upstream.end(body);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const run = req.url.match(/^\/run\/([A-Za-z0-9_-]{1,64})(\/.*)?$/);
  const runId = run ? run[1] : "";
  if (run) req.url = run[2] || "/";

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, port: PORT, coder: "fireworks", fireworksKey: Boolean(fireworksKey()), pid: process.pid }));
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, `no se pudo leer el body: ${err.message}`);
    return;
  }

  const json = body.length ? parseJson(body) : null;
  const model = json && typeof json.model === "string" ? json.model : "";

  if (!CODER_MODEL.test(model)) {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    forward(req, res, { url: new URL(ANTHROPIC_URL + req.url), headers, body, label: `claude[${model || "-"}]`, started });
    return;
  }

  const key = fireworksKey();
  if (!key) {
    log(`fireworks[${model}] ${req.url} -> 401 sin key`);
    sendError(res, 401, "No hay key de Fireworks. Corre claude-keys.");
    return;
  }

  const pathname = new URL(req.url, "http://gateway").pathname;
  // Estimacion local de count_tokens para no depender de que el proveedor lo exponga.
  if (pathname === "/v1/messages/count_tokens") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: Math.ceil(body.length / 4) }));
    return;
  }

  const clean = sanitizeForCoder(json);
  // Headers construidos desde cero: el token OAuth de Claude jamas sale hacia Fireworks.
  const headers = {
    "content-type": "application/json",
    accept: req.headers.accept || "application/json",
    authorization: `Bearer ${key}`,
    "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
  };
  const payload = Buffer.from(JSON.stringify(clean));
  forward(req, res, {
    url: new URL(FIREWORKS_URL + pathname),
    headers,
    body: payload,
    label: `fireworks[${clean.model}]${runId ? ` run=${runId}` : ""}`,
    started,
    onComplete: (status, contentType, text, aborted) => {
      if (status !== 200) return;
      // Un stream que termina sin message_stop tambien cuenta como cortado.
      const cut = aborted || (contentType.includes("text/event-stream") && !text.includes('"message_stop"'));
      let usage = extractUsage(contentType, text);
      let estimated = false;
      // Fireworks solo manda el usage real en message_delta: si se corto antes, se estima para no perder el rastro.
      if (cut && !usage.input_tokens && !usage.output_tokens) {
        usage = { input_tokens: Math.ceil(payload.length / 4), output_tokens: estimateStreamedTokens(text) };
        estimated = true;
      }
      recordUsage(clean.model, usage, runId, cut, estimated);
    },
  });
});

server.on("error", (err) => {
  log(`server error: ${err.message}`);
  console.error(err.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  log(`gateway escuchando en http://127.0.0.1:${PORT} (coder=fireworks, key=${Boolean(fireworksKey())})`);
  console.log(`gateway escuchando en http://127.0.0.1:${PORT}`);
});
