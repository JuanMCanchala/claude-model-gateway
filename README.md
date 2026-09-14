# claude-model-gateway

Herramientas locales para que **Claude orqueste y DeepSeek V4.1 Flash (en Fireworks) programe** dentro de Claude Code, sin perder nada de lo tuyo: claude-mem, prompt-improver, skills, hooks y CLAUDE.md.

Hay dos formas de usarlo:

| Forma                                  | Cuándo                                               | Cómo                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **`/fireworks <tarea>`** (recomendada) | Desde cualquier sesión normal, sin cambiar de sesión | Claude escribe el encargo, lo delega a un Claude Code sin interfaz que usa DeepSeek, revisa el resultado y te da el costo |
| **`flash-fw` / `funnelchat-fw`**       | Sesiones enteras de orquestación                     | Toda la sesión pasa por el gateway y trae el subagente `fireworks-coder:deepseek-coder`                                   |

`flash` / `funnelchat` siguen siendo Claude Code estándar.

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

Si lanzas delegaciones en paralelo, el consumo que reporta cada una incluye el de las otras que coincidieron en el tiempo. El total diario de `claude-gateway usage` sí es exacto.

## Comandos

| Comando                                             | Qué hace                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `claude-gateway status\|start\|stop\|restart\|logs` | Gestiona el gateway                                                                   |
| `claude-gateway usage [-Days N]`                    | Gasto en Fireworks por día, fuente y modelo, con USD estimado                         |
| `claude-keys`                                       | Pide la key de Fireworks (oculta), la guarda en `FIREWORKS_API_KEY` y prueba el coder |

## Rastro de gasto

- **Ledger:** `~/.claude-gateway/usage.jsonl`, con una línea por llamada a Fireworks (`source=coder`).
- **claude-mem:** si algún día vuelve a usar Fireworks, `usage.ps1` importa también su consumo (`source=claude-mem:<perfil>`) desde los logs del worker.
- **Precios:** `prices.json` (USD por 1M tokens, tier Standard). El costo se calcula al reportar.

## Modelos

| Uso                             | Modelo en Fireworks   | Entrada / caché / salida (USD/1M) |
| ------------------------------- | --------------------- | --------------------------------- |
| `/fireworks` y `deepseek-coder` | `deepseek-v4p1-flash` | 0.22 / 0.007 / 0.66               |

claude-mem sigue con **Claude** (provider `claude`) y no pasa por aquí.

## Estructura

```
gateway.mjs            proxy + registro de consumo
fw-delegate.mjs        delegación headless a DeepSeek (usada por /fireworks)
coder-rules.md         reglas del implementador (system prompt añadido)
skills/fireworks/      skill /fireworks (copiar a ~/.claude-<perfil>/skills/)
plugin/                plugin de sesión para flash-fw / funnelchat-fw
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
- Con una `ANTHROPIC_BASE_URL` que no es de Anthropic, Claude Code **apaga tool search**. Por eso los modos `-fw` y `fw-delegate` exportan `ENABLE_TOOL_SEARCH=true`.
