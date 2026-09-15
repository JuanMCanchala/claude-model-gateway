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
- **Criterios de aceptación:** comportamiento esperado y casos borde que importan.
- **Restricciones:** patrones del proyecto a seguir y qué no tocar.
- **Verificación:** el comando exacto que debe pasar. Es la única revisión que tendrá el trabajo: que pruebe de verdad los criterios de aceptación.

Límites del encargo (todo lo que pidas, Gemini lo razona y lo escribe contra el cupo de la cuenta):

- **Solo lo que pidió el usuario.** No agregues requisitos, extras de diseño ni "mejoras". Si crees que algo suma, propónselo al usuario antes de delegar.
- **Qué, no cómo.** No dictes la implementación ni resuelvas tú el contenido para que Gemini lo copie; nombra solo el patrón del proyecto a seguir. Evita "usa exactamente" y conteos exactos salvo que sean un requisito real.
- **Corto y proporcional.** Una tarea chica cabe en unas 15-40 líneas. Si pasa de ~60, divídela o recorta el alcance.

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

## 3. Revisar (sin rehacer el trabajo)

Revisar a fondo lo delegado es hacer el trabajo dos veces y se pierde el ahorro. La garantía es el comando de verificación del encargo, que Gemini corre y reporta.

- Lee solo lo que imprime el script: resultado, actividad, uso y `git status`.
- **Si la verificación pasó y no hay bloqueos, da la tarea por hecha.** No leas los archivos ni el diff, y no vuelvas a correr la verificación.
- Solo intervén si el script salió con error, la verificación falló, hay bloqueos o `git status` muestra archivos fuera de lo pedido. Usa `--resume latest` con el error concreto; arréglalo tú solo si es de 1-2 líneas.

## 4. Reportar al usuario

Qué se hizo, qué se verificó y el uso de tokens.
