# Mods de Claude Code · Dos2Locos

Marketplace de mods para [Claude Code](https://code.claude.com/docs/en/plugins/mods/overview).

## Instalar

```bash
claude plugin marketplace add Dos2Locos/claude-code-mods
claude plugin install clean-view@dos2locos-mods
```

En una sesión abierta, ejecuta `/reload-plugins` después de instalar o actualizar.

Para actualizar: `claude plugin marketplace update dos2locos-mods` y `claude plugin update clean-view@dos2locos-mods`.

## Mods

### clean-view

Vista limpia mientras Claude trabaja:

- Oculta las filas de llamadas a herramientas (ctrl+o sigue mostrándolas).
- Lista de pasos con su estado (○ pendiente, ◐ en curso, ✓ hecho, ✗ error) y barra de progreso sobre el prompt.
- Progreso junto al spinner: `Pensando · paso 3/5…`.
- Resumen breve al terminar: archivos modificados, comandos y errores.
- Se activa y desactiva con `0` (prompt vacío), el botón de la franja o `/clean-view [on|off]`.

Funciona en la terminal y en la pestaña Code de la app de escritorio. Requiere Claude Code v2.1.287 o posterior.
