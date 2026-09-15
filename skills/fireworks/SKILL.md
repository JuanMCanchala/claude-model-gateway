---
name: fireworks
description: Delega la escritura de código a DeepSeek V4.1 Flash en Fireworks sin cambiar de sesión. Tú (Claude) orquestas, escribes el encargo y revisas; DeepSeek implementa. Úsalo cuando el usuario escriba /fireworks, pida "hazlo con fireworks" o "que lo programe deepseek", o quiera ahorrar cupo de Claude en una implementación.
argument-hint: <tarea a implementar>
allowed-tools: Bash(node C:/Programacion/claude-model-gateway/fw-delegate.mjs:*), Bash(node "C:/Programacion/claude-model-gateway/fw-delegate.mjs":*), Read, Grep, Glob
---

# Delegar a DeepSeek en Fireworks

Tarea del usuario: $ARGUMENTS

DeepSeek corre como un Claude Code aparte, sin interfaz. **No ve esta conversación** y no tiene MCP ni web. Puede leer, editar y correr comandos en el proyecto, pero no puede hacer commit ni push.

## 1. Preparar el encargo

El encargo es lo que más define el gasto: todo lo que pidas, DeepSeek lo razona y lo escribe, y la salida es lo caro (0.66 USD/1M frente a 0.007 la entrada en caché). Investiga solo lo necesario (Read/Grep/Glob) para escribir un encargo que se entienda sin contexto:

- **Objetivo:** qué debe quedar funcionando.
- **Archivos:** qué se crea o se modifica, con rutas.
- **Criterios de aceptación:** comportamiento esperado y casos borde que importan.
- **Restricciones:** patrones del proyecto a seguir y qué no tocar.
- **Verificación:** el comando exacto que debe pasar.

Límites del encargo:

- **Solo lo que pidió el usuario.** No agregues requisitos, extras de diseño ni "mejoras". Si crees que algo suma, propónselo al usuario antes de delegar; no lo metas en el encargo.
- **Qué, no cómo.** No dictes la implementación (código, reglas CSS, estructura interna) ni resuelvas tú el contenido para que DeepSeek lo copie; nombra solo el patrón del proyecto a seguir. Evita "usa exactamente" y conteos exactos salvo que sean un requisito real: obligan a DeepSeek a re-verificarlo todo en su razonamiento.
- **Corto y proporcional.** Una tarea chica cabe en unas 15-40 líneas. Si pasa de ~60, divídela en varias delegaciones o recorta el alcance.

Si la tarea es trivial (1-2 líneas), hazla tú directamente y díselo al usuario.

## 2. Delegar

Usa exactamente esta forma: la ruta del script sin comillas y como primer argumento de `node`, para que el permiso de la skill la reconozca y no te pida aprobación.

```bash
node C:/Programacion/claude-model-gateway/fw-delegate.mjs --cwd "<ruta absoluta del proyecto>" <<'ENCARGO'
<encargo completo>
ENCARGO
```

- El timeout por defecto es de 30 min (`--timeout <min>`). Si puede tardar más de unos 5 min, lanza el comando con `run_in_background` y espera la notificación.
- Si hay partes independientes, lanza varias delegaciones en paralelo, una por parte y con archivos distintos.
- Si sale `[fw] Gateway apagado o sin key`, dile al usuario que corra `claude-gateway status` o `claude-keys`.

## 3. Revisar (sin rehacer el trabajo)

Revisar a fondo lo delegado es hacer el trabajo dos veces y se pierde el ahorro. La garantía es el comando de verificación del encargo, que DeepSeek corre y reporta: por eso debe probar de verdad el criterio de aceptación.

- Lee solo lo que imprime el script: resultado, verificación, consumo y `git status`.
- **Si la verificación pasó y no hay bloqueos, da la tarea por hecha.** No leas los archivos ni el diff, y no vuelvas a correr la verificación.
- Solo intervén si el script salió con error, la verificación falló, hay bloqueos o `git status` muestra archivos fuera de lo pedido. Vuelve a delegar con el error concreto; arréglalo tú solo si es de 1-2 líneas.

## 4. Reportar al usuario

Qué se hizo, qué se verificó y el costo en Fireworks que imprime el script (sección "Consumo en Fireworks").
