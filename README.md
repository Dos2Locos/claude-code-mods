# Mods de Claude Code · Dos2Locos

Marketplace de mods para [Claude Code](https://code.claude.com/docs/en/plugins/mods/overview).

## Instalar

```bash
claude plugin marketplace add Dos2Locos/claude-code-mods
claude plugin install clean-view@dos2locos-mods
claude plugin install openspec-tracker@dos2locos-mods
claude plugin install clean-bar@dos2locos-mods
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

### clean-bar

Clean View y Context Bar en un único mod: una caja compacta sobre el prompt, con dos secciones, que no crece con cada paso.

- Oculta las filas de llamadas a herramientas (ctrl+o sigue mostrándolas).
- Muestra solo la tarea en curso del plan (TodoWrite, Tasks o `work_state_write` de claude-mem) y, debajo, la acción que se está ejecutando (`↳ Editar app.ts`).
- Barra de progreso y porcentaje del plan, con tarea `n de m` y tiempo transcurrido.
- Sin plan, muestra la acción actual y el número de pasos (no hay porcentaje que calcular).
- Al terminar, resumen breve: archivos modificados, comandos y errores.
- Sección de contexto (como context-bar): tokens usados de la ventana, umbral de autocompactado, porcentaje, barra apilada por categoría y leyenda. Se refresca al acabar cada turno y tras `/compact`.
- Cada sección se pliega a una sola línea con `1` (progreso) y `2` (contexto) en el prompt vacío, o con su botón `▾`/`▸`. Plegadas muestran la tarea actual con mini barra y porcentaje, y el uso de contexto con mini barra apilada y porcentaje. La elección se recuerda entre sesiones.
- Se activa y desactiva con `0` (prompt vacío), el botón de la caja o `/clean-bar [on|off]`.

Sustituye a clean-view y context-bar: conviene no tenerlos activos a la vez.

### openspec-tracker

Seguimiento del flujo de [OpenSpec](https://github.com/Fission-AI/OpenSpec) en el proyecto de la sesión:

- `/openspec` abre un panel con los cambios activos: fase (`propuesta → specs → diseño → tareas → implementación → listo para archivar`), barra de tareas y última modificación. Pulsa `1`–`9` para abrir uno.
- Detalle de un cambio: artefactos (✓ hecho, ○ pendiente), tareas de `tasks.md` por sección y validación con `openspec validate`.
- Botones `a` Aplicar, `x` Archivar y `e` Revisar: escriben `/opsx:apply <id>` (o equivalente) en el prompt sin enviarlo. `v` Validar y `r` Actualizar se ejecutan al momento.
- Línea de estado con el cambio en curso, detectado por lo que Claude edita o ejecuta: `◐ OpenSpec 05-update-member-screens-ux · 7/15 · implementación`.
- Aviso cuando un cambio completa todas sus tareas.

Requiere la CLI `openspec` (v1.x) instalada. Solo se activa en proyectos con carpeta `openspec/`.
