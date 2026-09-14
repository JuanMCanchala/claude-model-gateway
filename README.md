# claude-model-gateway

Herramientas locales para que **Claude orqueste y DeepSeek V4.1 Flash (en Fireworks) programe** dentro de Claude Code, sin perder nada de lo tuyo: claude-mem, prompt-improver, skills, hooks y CLAUDE.md.

Se usa con **`/fireworks <tarea>`** desde cualquier sesión normal (`flash` / `funnelchat`), sin cambiar de sesión: Claude escribe el encargo, lo delega a un Claude Code sin interfaz que usa DeepSeek, revisa el resultado y te da el costo.

```
Sesión normal (Opus) ──/fireworks──► node fw-delegate.mjs ──► claude -p --model deepseek-v4p1-flash
                                                                  │ ANTHROPIC_BASE_URL=http://127.0.0.1:4141
                                                                  ▼
                                   gateway.mjs ── deepseek-* ──► Fireworks /inference/v1/messages  (consumo → usage.jsonl)
                                               └─ otro modelo ─► api.anthropic.com (passthrough)
```

## `/fireworks`: delegar sin cambiar de sesión

Es una skill instalada en `~/.claude-flash/skills/fireworks` y `~/.claude-funnelchat/skills/fireworks` (el original está en `skills/` del repo). Claude también la usa si le dices "hazlo con fireworks".

`fw-delegate.mjs`:

- Levanta el gateway si hace falta.
- Lanza `claude -p` con DeepSeek como modelo principal, subagentes y modelo rápido. El proceso hijo:
  - Corre **sin hooks ni MCP** (`disableAllHooks`, `--strict-mcp-config`), así que no gasta cupo de Claude ni ensucia claude-mem.
  - Usa `acceptEdits` y `Bash`, pero tiene bloqueados `git push/commit/reset/checkout`, `rm -rf`, subagentes y web.
  - Sigue las reglas de implementador de `coder-rules.md`.
- Al terminar imprime el resultado, el **consumo en Fireworks de esa delegación** (tokens y USD) y el `git status`.

Uso directo, sin skill:

```bash
node C:/Programacion/claude-model-gateway/fw-delegate.mjs --cwd <proyecto> [--timeout 30] [--model deepseek-v4p1-flash] <<'ENCARGO'
...encargo autocontenido: objetivo, archivos, comportamiento, restricciones, verificación...
ENCARGO
```

Cada delegación usa su propia ruta del gateway (`/run/<id>`), así que el consumo que reporta es exacto aunque lances varias en paralelo.

## `/codex`: delegar a Codex con tu cuenta de ChatGPT

Es la misma idea que `/fireworks`, pero el implementador es **Codex** (`gpt-5.5` por defecto) y usa **tu sesión de ChatGPT** (`codex login`). No hay API key ni gateway, y no cuesta por token: cuenta contra el cupo del plan (ventana de 5 h + semanal). La skill está en `skills/codex/` y se copia a `~/.claude-<perfil>/skills/codex`.

`codex-delegate.mjs` copia el enfoque del motor CLI de [Houston](https://github.com/gethouston/houston) (MIT, © ja-818; código Rust previo al commit `a7a52b74`):

- **Invocación:** `codex exec --json --skip-git-repo-check -p <profile> -c model_reasoning_effort="…" --model … --cd … --sandbox workspace-write [resume <thread>] -`, con el encargo por stdin.
  - Los flags globales van **antes** de `resume`.
  - `-c model_reasoning_effort` va siempre, para que un valor raro en `config.toml` no rompa el CLI.
- **Instrucciones de sistema** (`coder-rules.md` + reglas headless): van en un profile temporal `~/.codex/cmgw-tmp-*.config.toml` (`developer_instructions`), nunca en argv (límite de 32 767 caracteres de Windows). Se borra al terminar, y los restos de más de 24 h se limpian.
- **Login:** se comprueba antes con `codex login status`. Si no se puede clasificar, se miran las claves de `auth.json`.
- **Errores clasificados:**
  - modelo no disponible con cuenta ChatGPT;
  - sesión caducada (corre `codex login`);
  - cupo agotado, con hora de reinicio;
  - 429, 5xx y red.
  - Se ignora el ruido de reconexiones y de los MCP de tu `config.toml`.
- **Reanudar:** `--resume <thread>` sigue la misma sesión de Codex. Si ya no existe, se relanza como nueva.
- **Timeout:** `taskkill /T /F`.

A diferencia de Houston, que usaba `--dangerously-bypass-approvals-and-sandbox`, aquí va `--sandbox workspace-write`. En Windows escribe gracias a `[windows] sandbox = "elevated"` de tu `config.toml`, por eso no se usa `--ignore-user-config`.

```bash
node C:/Programacion/claude-model-gateway/codex-delegate.mjs --cwd <proyecto> [--effort low|medium|high|xhigh] [--model gpt-5.5] [--resume <thread>] <<'ENCARGO'
...encargo...
ENCARGO
```

El uso de tokens de cada corrida queda en el ledger con `source=codex`. Como va incluido en el plan, sale a USD 0 en `claude-gateway usage`.

## `/gemini`: delegar a Gemini CLI con tu cuenta de Google

Es lo mismo que `/codex`, pero con **Gemini CLI** (`@google/gemini-cli`). Usa tu login de Google, que se hace una vez corriendo `gemini` y eligiendo _Sign in with Google_, o `GEMINI_API_KEY`. La skill está en `skills/gemini/`.

`gemini-delegate.mjs` copia el motor CLI de [Houston](https://github.com/gethouston/houston) (MIT, © ja-818; código Rust previo a `a7a52b74`):

- **Invocación:** `gemini -p "" --output-format stream-json --yolo --skip-trust --include-directories <cwd> [--model] [--resume latest]`, con el prompt por stdin.
- **Instrucciones de sistema:** `coder-rules.md` va envuelto en `<system>…</system>` delante del encargo, porque el CLI no tiene flag de system prompt.
- **Home aislado:** `HOME`/`USERPROFILE` apuntan a `~/.claude-gateway/gemini-home`, que solo contiene `oauth_creds.json`, `google_accounts.json` y `.env` (enlazados o copiados) más un `settings.json` mínimo. Así no se cuelan tu `GEMINI.md` global ni tus MCP.
- **Sonda de auth antes de lanzar:** sin login, Gemini pregunta por stdin si abre el navegador y se come el encargo.
- **Errores:** se clasifican por `result.error.type` (`FatalAuthenticationError`, `RetryableQuotaError`, `GaxiosError` 401/429/5xx, `MaxSessionTurnsError`) y por las líneas `Attempt N failed … Retrying after / Max attempts reached` de stderr.

Diferencias con Houston:

- Houston usaba `--yolo` sin límites; aquí se añade `--policy gemini-policy.toml`, que niega `git push/commit/reset/checkout`, borrados recursivos y publicar.
- Se lanza el bundle JS con `node`, no el shim `.cmd`.
- Los tokens van al ledger con `source=gemini` y salen a USD 0 en `claude-gateway usage`. Si usas `GEMINI_API_KEY` sí se factura, pero eso no se refleja aquí.

## Comandos

| Comando                                             | Qué hace                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `claude-gateway status\|start\|stop\|restart\|logs` | Gestiona el gateway                                                                   |
| `claude-gateway usage [-Days N]`                    | Gasto en Fireworks por día, fuente y modelo, con USD estimado                         |
| `claude-keys`                                       | Pide la key de Fireworks (oculta), la guarda en `FIREWORKS_API_KEY` y prueba el coder |

## Rastro de gasto

- **Ledger:** `~/.claude-gateway/usage.jsonl`, con una línea por llamada a Fireworks (`source=coder`).
  - `run_id`: la delegación a la que pertenece. Sale del prefijo `/run/<id>` de `ANTHROPIC_BASE_URL`.
  - `aborted: true`: la respuesta se cortó; el gateway corta también la conexión con Fireworks para que no siga generando.
  - `estimated: true`: Fireworks solo manda el conteo real al final del stream, así que si se cortó antes los tokens se estiman (request/4 y deltas/4).
- **claude-mem:** si algún día vuelve a usar Fireworks, `usage.ps1` importa también su consumo (`source=claude-mem:<perfil>`) desde los logs del worker.
- **Precios:** `prices.json` (USD por 1M tokens, tier Standard). El costo se calcula al reportar.

## Modelos

| Uso          | Modelo en Fireworks   | Entrada / caché / salida (USD/1M) |
| ------------ | --------------------- | --------------------------------- |
| `/fireworks` | `deepseek-v4p1-flash` | 0.22 / 0.007 / 0.66               |

claude-mem sigue con **Claude** (provider `claude`) y no pasa por aquí.

## Estructura

```
gateway.mjs            proxy + registro de consumo
fw-delegate.mjs        delegación headless a DeepSeek (usada por /fireworks)
coder-rules.md         reglas del implementador (system prompt añadido)
skills/fireworks/      skill /fireworks (copiar a ~/.claude-<perfil>/skills/)
codex-delegate.mjs     delegación headless a Codex con cuenta ChatGPT (usada por /codex)
skills/codex/          skill /codex (copiar a ~/.claude-<perfil>/skills/)
gemini-delegate.mjs    delegación headless a Gemini CLI con cuenta Google (usada por /gemini)
gemini-policy.toml     política que niega git push/commit, borrados recursivos y publicar
skills/gemini/         skill /gemini (copiar a ~/.claude-<perfil>/skills/)
claude-gateway.ps1     start/stop/status/logs/usage
usage.ps1              resumen de gasto
claude-keys.ps1        alta de la key de Fireworks
prices.json            precios por modelo
```

## Dónde vive cada cosa (fuera del repo)

- **Key de Fireworks:** variable de usuario `FIREWORKS_API_KEY`. `claude-gateway.ps1` la inyecta al proceso del gateway.
- **Lanzadores y `claude-gateway` / `claude-keys`:** perfil de PowerShell (`$PROFILE`).
- **Log:** `~/.claude-gateway/gateway.log`, con una línea por request, sin headers ni keys.

## Qué adapta el gateway para Fireworks

- Quita `cache_control`, las server tools (web_search, code_execution…), `container`, `mcp_servers`, `service_tier`, `top_k` y `context_management`.
- `thinking`: Fireworks acepta `adaptive` y `disabled` tal cual; a `enabled` sin `budget_tokens` le agrega el budget, porque si no responde 400.
- Construye los headers desde cero, así que el token OAuth de Claude **nunca** sale hacia Fireworks.
- `count_tokens` se estima en local.

## Límites conocidos

- DeepSeek no tiene caché de prompts de Anthropic, PDFs ni WebSearch. Fireworks sí aplica su propia caché de prefijos, que es barata.
- Claude Code registra `unrecognized_model` para `deepseek-*`. Es solo un aviso.
- Con una `ANTHROPIC_BASE_URL` que no es de Anthropic, Claude Code **apaga tool search**. Por eso `fw-delegate` exporta `ENABLE_TOOL_SEARCH=true`.
