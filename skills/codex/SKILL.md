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
- **Criterios de aceptación:** comportamiento esperado y casos borde que importan.
- **Restricciones:** patrones del proyecto a seguir y qué no tocar.
- **Verificación:** el comando exacto que debe pasar. Es la única revisión que tendrá el trabajo: que pruebe de verdad los criterios de aceptación.

Límites del encargo (todo lo que pidas, Codex lo razona y lo escribe contra el cupo del plan):

- **Solo lo que pidió el usuario.** No agregues requisitos, extras de diseño ni "mejoras". Si crees que algo suma, propónselo al usuario antes de delegar.
- **Qué, no cómo.** No dictes la implementación ni resuelvas tú el contenido para que Codex lo copie; nombra solo el patrón del proyecto a seguir. Evita "usa exactamente" y conteos exactos salvo que sean un requisito real.
- **Corto y proporcional.** Una tarea chica cabe en unas 15-40 líneas. Si pasa de ~60, divídela o recorta el alcance.

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

## 3. Revisar (sin rehacer el trabajo)

Revisar a fondo lo delegado es hacer el trabajo dos veces y se pierde el ahorro. La garantía es el comando de verificación del encargo, que Codex corre y reporta.

- Lee solo lo que imprime el script: resultado, actividad, uso y `git status`.
- **Si la verificación pasó y no hay bloqueos, da la tarea por hecha.** No leas los archivos ni el diff, y no vuelvas a correr la verificación.
- Solo intervén si el script salió con error, la verificación falló, hay bloqueos o `git status` muestra archivos fuera de lo pedido. Usa `--resume <thread>` con el error concreto; arréglalo tú solo si es de 1-2 líneas.

## 4. Reportar al usuario

Qué se hizo, qué se verificó y el uso de tokens. Ese uso no cuesta dinero: cuenta contra el cupo de ChatGPT.
