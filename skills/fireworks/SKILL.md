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
node C:/Programacion/claude-model-gateway/fw-delegate.mjs --cwd "<ruta absoluta del proyecto>" <<'ENCARGO'
<encargo completo>
ENCARGO
```

- El timeout por defecto es de 30 min (`--timeout <min>`). Si puede tardar más de unos 5 min, lanza el comando con `run_in_background` y espera la notificación.
- Si hay partes independientes, lanza varias delegaciones en paralelo, una por parte y con archivos distintos.
- Si sale `[fw] Gateway apagado o sin key`, dile al usuario que corra `claude-gateway status` o `claude-keys`.

## 3. Revisar

- Lee el resultado y el `git status` que imprime el script.
- Revisa el diff de los archivos tocados y **corre tú la verificación**. No te fíes solo del reporte.
- Arreglos menores los haces tú. Si falló algo grande, vuelve a delegar con el error concreto.

## 4. Reportar al usuario

Qué se hizo, qué se verificó y el costo en Fireworks que imprime el script (sección "Consumo en Fireworks").
