---
name: gemini
description: Delega la escritura de código a Gemini CLI (Google) usando la cuenta de Google del usuario, sin cambiar de sesión. Tú (Claude) orquestas, escribes el encargo y revisas; Gemini implementa. Úsalo cuando el usuario escriba /gemini o pida "hazlo con gemini" / "que lo programe gemini".
argument-hint: <tarea a implementar>
allowed-tools: Bash(node C:/Programacion/claude-model-gateway/gemini-delegate.mjs:*), Bash(node "C:/Programacion/claude-model-gateway/gemini-delegate.mjs":*), Read, Grep, Glob
---

# Delegar a Gemini (cuenta de Google)

Tarea del usuario: $ARGUMENTS

Gemini corre como un `gemini` headless aparte, con tu login de Google. Usa un home aislado, así que no carga tu `GEMINI.md` global ni tus MCP. **No ve esta conversación.** Puede leer, editar y correr comandos en el proyecto; una política bloquea git commit/push/reset, los borrados recursivos y publicar.

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
node C:/Programacion/claude-model-gateway/gemini-delegate.mjs --cwd "<ruta absoluta del proyecto>" <<'ENCARGO'
<encargo completo>
ENCARGO
```

- **Opciones:** `--model <id>` (por defecto, el del CLI) y `--timeout <min>` (por defecto 30).
- **Tareas largas:** si puede tardar más de unos 5 min, lanza el comando con `run_in_background` y espera la notificación.
- **Correcciones:** para una segunda ronda sobre lo mismo, usa `--resume latest`.
- **Sin sesión:** si el script dice "Sin autenticacion" o "no tiene una sesion valida", pídele al usuario que corra `gemini` en una terminal y elija Sign in with Google.
- **Cupo agotado:** si dice que se acabó el cupo, ofrece `/codex` o `/fireworks`.

## 3. Revisar

- Lee el resultado, la actividad (archivos y comandos) y el `git status` que imprime el script.
- Revisa el diff de los archivos tocados y **corre tú la verificación**. No te fíes solo del reporte.
- Arreglos menores los haces tú. Si falló algo grande, usa `--resume latest` con el error concreto.

## 4. Reportar al usuario

Qué se hizo, qué se verificó y el uso de tokens.
