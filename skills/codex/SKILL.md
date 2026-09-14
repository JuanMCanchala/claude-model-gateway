---
name: codex
description: Delega la escritura de código a Codex (OpenAI) usando la cuenta de ChatGPT del usuario, sin cambiar de sesión y sin costo por token (va contra el cupo del plan). Tú (Claude) orquestas, escribes el encargo y revisas; Codex implementa. Úsalo cuando el usuario escriba /codex, pida "hazlo con codex" o "que lo programe codex/gpt".
argument-hint: <tarea a implementar>
allowed-tools: Bash(node C:/Programacion/claude-model-gateway/codex-delegate.mjs:*), Bash(node "C:/Programacion/claude-model-gateway/codex-delegate.mjs":*), Read, Grep, Glob
---

# Delegar a Codex (cuenta de ChatGPT)

Tarea del usuario: $ARGUMENTS

Codex corre como un `codex exec` aparte, sin interfaz, con tu sesión de ChatGPT y en sandbox `workspace-write`. **No ve esta conversación.** Puede leer, editar y correr comandos dentro del proyecto, y tiene instrucciones de no hacer commit ni push.

## 1. Preparar el encargo

Investiga solo lo necesario (Read/Grep/Glob) para escribir un encargo que se entienda sin contexto:

- **Objetivo:** qué debe quedar funcionando.
- **Archivos:** qué se crea o se modifica, con rutas.
- **Comportamiento esperado** y casos borde relevantes.
- **Restricciones:** patrones del proyecto a seguir y qué no tocar.
- **Verificación:** el comando exacto que debe pasar.

Si la tarea es trivial (1-2 líneas), hazla tú directamente y díselo al usuario.

## 2. Delegar

Usa exactamente esta forma: la ruta del script sin comillas y como primer argumento de `node`, para que el permiso de la skill la reconozca y no te pida aprobación.

```bash
node C:/Programacion/claude-model-gateway/codex-delegate.mjs --cwd "<ruta absoluta del proyecto>" <<'ENCARGO'
<encargo completo>
ENCARGO
```

- **Opciones:** `--model gpt-5.5` (por defecto), `--effort low|medium|high|xhigh` (por defecto `medium`; usa `high` en tareas difíciles) y `--timeout <min>` (por defecto 30).
- **Tareas largas:** si puede tardar más de unos 5 min, lanza el comando con `run_in_background` y espera la notificación.
- **Correcciones:** para una segunda ronda sobre lo mismo, usa `--resume <thread>`; el script imprime el thread. Codex conserva así su contexto.
- **Sesión caída:** si el diagnóstico dice que la sesión de ChatGPT no es válida, pídele al usuario que corra `codex login`.
- **Cupo agotado:** si dice que se acabó el cupo, ofrece `/fireworks` como alternativa.

## 3. Revisar

- Lee el resultado, la actividad (archivos y comandos) y el `git status` que imprime el script.
- Revisa el diff de los archivos tocados y **corre tú la verificación**. No te fíes solo del reporte.
- Arreglos menores los haces tú. Si falló algo grande, usa `--resume` con el error concreto.

## 4. Reportar al usuario

Qué se hizo, qué se verificó y el uso de tokens. Ese uso no cuesta dinero: cuenta contra el cupo de ChatGPT.
