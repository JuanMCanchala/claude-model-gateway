# claude-model-gateway

Gateway local (Node, sin dependencias) para usar **otros modelos dentro de Claude Code sin perder nada** de lo que ya tienes: claude-mem, prompt-improver, skills, hooks y CLAUDE.md.

Hoy lo usa un solo modo: **Opus orquesta y DeepSeek V4.1 Flash (en Fireworks) programa** como subagente. Es opcional por sesión.

```
Claude Code (flash-fw | funnelchat-fw)
   │  ANTHROPIC_BASE_URL=http://127.0.0.1:4141  +  --plugin-dir plugin/
   ▼
gateway.mjs ── model deepseek-* / accounts/fireworks/* ──► https://api.fireworks.ai/inference/v1/messages
           │                                                (key de Fireworks, consumo → usage.jsonl)
           └── cualquier otro ─────────────────────────► https://api.anthropic.com  (tu sesión de Claude, intacta)

claude-mem worker ── provider openrouter + base URL ──► https://api.fireworks.ai/inference/v1  (siempre, en ambos modos)
```

## Modos

| Comando                      | Qué abre                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `flash` / `funnelchat`       | **Claude Code estándar.** Sin gateway ni subagente DeepSeek                                                                                |
| `flash-fw` / `funnelchat-fw` | **Modo orquestación.** Levanta el gateway y carga el plugin `fireworks-coder` (subagente `deepseek-coder` + instrucciones de orquestación) |

Si el gateway no arranca, los comandos `-fw` avisan y abren el modo estándar.

## Comandos

| Comando                                             | Qué hace                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `claude-gateway status\|start\|stop\|restart\|logs` | Gestiona el gateway                                                                |
| `claude-gateway usage [-Days N]`                    | Gasto en Fireworks por día, fuente y modelo, con USD estimado                      |
| `claude-keys`                                       | Pide la key de Fireworks (oculta), la guarda, conecta claude-mem y prueba el coder |

## Rastro de gasto

- **Ledger:** `~/.claude-gateway/usage.jsonl`, con una línea por llamada: `ts`, `source`, `model` y tokens.
- **Qué se registra:**
  - `source=coder`: lo escribe el gateway en cada respuesta de Fireworks, ya sea JSON o streaming.
  - `source=claude-mem:<perfil>`: se importa de los logs del worker de claude-mem cada vez que abres un perfil o corres `usage`. La importación es incremental.
- **Precios:** `prices.json` (USD por 1M tokens, tier Standard, consultados en las fichas de Fireworks). El costo se calcula al reportar, así que actualizar precios recalcula el histórico.
- El ledger vive fuera del repo, porque es dato local y no código.

## Modelos

| Uso                        | Modelo en Fireworks   | Entrada / caché / salida (USD/1M) |
| -------------------------- | --------------------- | --------------------------------- |
| Subagente `deepseek-coder` | `deepseek-v4p1-flash` | 0.22 / 0.007 / 0.66               |
| claude-mem (resúmenes)     | `deepseek-v4p1-flash` | 0.22 / 0.007 / 0.66               |

Hay alias en `gateway.mjs` (`deepseek-flash`, `deepseek-v4-pro`). Cualquier otro `deepseek-*` se manda como `accounts/fireworks/models/<nombre>`.

## Estructura

```
gateway.mjs            proxy + registro de consumo
claude-gateway.ps1     start/stop/status/logs/usage
usage.ps1              import de claude-mem + resumen de gasto
claude-keys.ps1        alta de la key de Fireworks
prices.json            precios por modelo
plugin/                plugin de sesión (solo modo -fw)
  agents/deepseek-coder.md
  hooks/session-start.mjs   inyecta las reglas de orquestación
```

## Dónde vive cada cosa (fuera del repo)

- **Key de Fireworks:** `OPENROUTER_API_KEY` en `~/.claude-mem/.env` y `~/.claude-mem-funnelchat/.env`. El gateway la lee de ahí en cada request. La variable de usuario `FIREWORKS_API_KEY` tiene prioridad si existe.
- **Provider de claude-mem:** `settings.json` de cada data dir.
- **Lanzadores:** perfil de PowerShell (`$PROFILE`).
- **Log:** `~/.claude-gateway/gateway.log`, con una línea por request, sin headers ni keys.

## Qué adapta el gateway para Fireworks

- Quita `cache_control`, las server tools (web_search, code_execution…), `container`, `mcp_servers`, `service_tier`, `top_k` y `context_management`.
- Construye los headers desde cero, así que el token OAuth de Claude **nunca** sale hacia Fireworks.
- `count_tokens` se estima en local.

## Límites conocidos

- En el subagente no hay caché de prompts de Anthropic, PDFs ni WebSearch.
- Claude Code registra `unrecognized_model` para el modelo del subagente. Es solo un aviso.
- Con una `ANTHROPIC_BASE_URL` que no es de Anthropic, Claude Code **apaga tool search**: todas las tools MCP entran en el prompt y funnelchat pasó de 200k ("Prompt is too long"). Por eso los lanzadores `-fw` exportan `ENABLE_TOOL_SEARCH=true`.
- claude-mem manda a Fireworks el contenido de las herramientas para resumirlo, comandos incluidos.
