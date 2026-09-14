// SessionStart del plugin fireworks-coder: solo existe en sesiones abiertas con flash-fw / funnelchat-fw.
const context = [
  "MODO ORQUESTACIÓN (Claude + DeepSeek en Fireworks) activo en esta sesión.",
  "- Tú (Claude) orquestas: investigas, decides el diseño, divides el trabajo y revisas el resultado.",
  "- La escritura y edición de código se delega al subagente deepseek-coder (DeepSeek V4.1 Flash en Fireworks). Cada encargo lleva los archivos, el comportamiento esperado y cómo verificarlo, porque el subagente no ve la conversación.",
  "- Tareas independientes pueden ir en paralelo con varios deepseek-coder.",
  "- Al volver, revisa el diff y la verificación que reporta antes de darlo por hecho. Arreglos de 1-2 líneas puedes hacerlos tú directamente.",
  "- Si el subagente falla con [gateway] en el error: el usuario puede usar claude-gateway status / logs, o claude-keys.",
].join("\n");

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
