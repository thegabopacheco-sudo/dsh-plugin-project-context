# dsh-plugin-project-context — Project Context

Contexto de proyecto para DeepSeek Harness: escanea manifiestos, README, stack, git y archivos recientes, y genera un pack de contexto Markdown guardable.

## Herramientas

| Tool | Qué hace |
|---|---|
| `status` | Estado |
| `scan` | Escanear proyecto |
| `save` | Guardar contexto |

## Instalación

Desde **DSH → Settings → Plugins** instala `github:thegabopacheco-sudo/dsh-plugin-project-context` y permite el script de instalación.

```
dsh plugin --profile <perfil> add github:thegabopacheco-sudo/dsh-plugin-project-context
```

## Seguridad

- Lectura por defecto; escritura solo con `confirm:true` y pedido explícito.
- `DSH_PROJECT_CONTEXT_MODE=read-only` desactiva acciones.
- Listas blancas y auditoría en `<DSH_HOME>\cache\project-context\audit.jsonl`.

## Licencia

MIT © thegabopacheco-sudo
