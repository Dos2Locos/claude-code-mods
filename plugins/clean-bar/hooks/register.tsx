// Clean Bar: Clean View y Context Bar en una sola caja sobre el prompt.
//   Arriba, el progreso: el prompt, «Paso n de m» con la barra del plan y su porcentaje, y solo
//   las tareas en curso, cada una con una barra animada de lado a lado (sin plan, la actividad). Debajo, la ventana de contexto: barra apilada por categoría y leyenda.
//   Cada sección se pliega a una línea con `1` y `2` (prompt vacío) o su botón ▾/▸.
//   Oculta las filas de herramientas. Se alterna con `0` (prompt vacío), el botón o /clean-bar.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { Compact, Reading, Run, Step, StepStatus } from '../types'
import { GLYPH, SPLIT, cells, legend, share, toReading, tokens } from './context'

const isOn = atom({ plugin: 'clean-bar', key: 'isOn' } as const, true)
const run = atom({ plugin: 'clean-bar', key: 'run' } as const, null as Run | null)
const reading = atom({ plugin: 'clean-bar', key: 'reading' } as const, null as Reading | null)
const compact = atom({ plugin: 'clean-bar', key: 'compact' } as const, { progress: false, context: false } as Compact)
/** Fotograma de la animación de las barras «En curso»; avanza mientras hay un turno. */
const frame = atom({ plugin: 'clean-bar', key: 'frame' } as const, 0)

const STORE_KEY = 'isOn'
const COMPACT_KEY = 'compact'
const TOGGLE_HOTKEY = '0'
const FOLD_HOTKEY: Record<keyof Compact, string> = { progress: '1', context: '2' }
/** Ancho de las barras en modo compacto. */
const MINI_BAR = 16
const MIN_WIDTH = 20
/** Ancho de la barra animada de cada tarea en curso. */
const WORK_BAR = 16
const FRAME_MS = 120
const STATUS_LABEL = 'En curso'
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
/** La lista de trabajo de claude-mem (`work_state_write`), con el prefijo MCP que tenga instalado. */
const WORK_STATE_TOOL = /work_state_write$/
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const HIDDEN_ROWS = ['ToolUse', 'ToolResult', 'ToolGroup', 'ToolProgress'] as const

const ACCENT = '#d97757'
const OK = '#9ece6a'
const WARN = '#e0af68'
const TRACK = '#808080'
const PINK = '#f7768e'
const ICON: Record<StepStatus, string> = { pending: '○', running: '◐', done: '✓', error: '✗' }
const COLOR: Record<StepStatus, string | undefined> = { pending: undefined, running: ACCENT, done: OK, error: 'red' }

const emptyRun = (startedAt: number): Run => ({
  isWorking: true,
  startedAt,
  durationMs: 0,
  plan: [],
  toolCalls: 0,
  changedFiles: [],
  commands: 0,
  errors: 0,
  isAborted: false,
})

function field(e: object, name: string): string | undefined {
  const value = (e as Record<string, unknown>)[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function clip(text: string, max = 48): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Una frase legible para cada llamada, en lugar de `Bash(...)`. */
export function describeCall(tool: string, e: object): string {
  const file = field(e, 'file_path') ?? field(e, 'notebook_path')
  switch (tool) {
    case 'Read':
      return `Leer ${file ? basename(file) : 'archivo'}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editar ${file ? basename(file) : 'archivo'}`
    case 'Write':
      return `Escribir ${file ? basename(file) : 'archivo'}`
    case 'Bash': {
      const what = field(e, 'description') ?? field(e, 'command')
      return what ? `Ejecutar: ${clip(what)}` : 'Ejecutar comando'
    }
    case 'Grep':
    case 'Glob': {
      const pattern = field(e, 'pattern')
      return pattern ? `Buscar «${clip(pattern, 32)}»` : 'Buscar en el código'
    }
    case 'WebFetch': {
      const url = field(e, 'url')
      return `Consultar ${url ? clip(url.replace(/^https?:\/\//, '').split('/')[0] ?? url, 32) : 'página web'}`
    }
    case 'WebSearch':
      return `Buscar en la web: ${clip(field(e, 'query') ?? '', 36)}`
    case 'Agent':
    case 'Task':
      return `Delegar: ${clip(field(e, 'description') ?? 'subtarea', 40)}`
    case 'Skill':
      return `Usar habilidad ${field(e, 'skill') ?? ''}`.trim()
    default: {
      const short = tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') : tool
      return `Usar ${short}`
    }
  }
}

function todoStatus(status: string): StepStatus {
  return status === 'completed' || status === 'done'
    ? 'done'
    : status === 'in_progress' || status === 'doing'
      ? 'running'
      : 'pending'
}

/** Una entrada de work_state_write con `task` crea o actualiza esa tarea del plan; `dropped` la quita. */
export function applyWorkState(plan: Step[], e: object): Step[] {
  const list = field(e, 'list')
  const fields = (e as { fields?: Record<string, unknown> }).fields ?? {}
  const task = typeof fields.task === 'string' && fields.task !== '' ? fields.task : undefined
  if (!list || !task) return plan // estado de la lista, no una tarea
  const id = `${list}/${task}`
  const status = typeof fields.status === 'string' ? fields.status : undefined
  if (status === 'dropped') return plan.filter(s => s.id !== id)
  const existing = plan.find(s => s.id === id)
  if (!existing) return [...plan, { id, label: task, status: todoStatus(status ?? 'todo') }]
  return plan.map(s => (s.id === id && status ? { ...s, status: todoStatus(status) } : s))
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** Progreso del plan: tareas hechas, total y porcentaje. */
export function progress(plan: Step[]): { done: number; total: number; percent: number } {
  const done = plan.filter(s => s.status === 'done' || s.status === 'error').length
  const total = plan.length
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/** La tarea en curso; si ninguna lo está, la siguiente pendiente. */
export function currentTask(plan: Step[]): { step: Step; index: number } | undefined {
  const running = plan.findIndex(s => s.status === 'running')
  const index = running !== -1 ? running : plan.findIndex(s => s.status === 'pending')
  return index === -1 ? undefined : { step: plan[index]!, index }
}

export function bar(percent: number, width: number): { filled: string; empty: string } {
  const n = Math.round((percent / 100) * width)
  return { filled: '█'.repeat(n), empty: '─'.repeat(width - n) }
}

function hex(color: string): number[] {
  return [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16))
}

/** Mezcla dos colores `#rrggbb`: `t` 0 es `from`, 1 es `to`. */
export function mix(from: string, to: string, t: number): string {
  const a = hex(from)
  const b = hex(to)
  return `#${a.map((v, i) => Math.round(v + (b[i]! - v) * t).toString(16).padStart(2, '0')).join('')}`
}

/** Inicio del tramo de `size` celdas que va y vuelve dentro de `width` en el fotograma `n`. */
export function sweep(n: number, width: number, size: number): number {
  const span = Math.max(0, width - size)
  if (span === 0) return 0
  const p = n % (span * 2)
  return p <= span ? p : span * 2 - p
}

/** El resumen breve que se muestra al terminar. */
export function summarize(r: Run): string {
  const parts: string[] = []
  const files = r.changedFiles
  if (files.length > 0) {
    const names = files.slice(0, 4).map(basename).join(', ')
    const more = files.length > 4 ? ` y ${files.length - 4} más` : ''
    parts.push(`${files.length} ${files.length === 1 ? 'archivo modificado' : 'archivos modificados'} (${names}${more})`)
  } else {
    parts.push('sin cambios en archivos')
  }
  if (r.commands > 0) parts.push(`${r.commands} ${r.commands === 1 ? 'comando' : 'comandos'}`)
  if (r.errors > 0) parts.push(`${r.errors} ${r.errors === 1 ? 'error' : 'errores'}`)
  return `${r.isAborted ? 'Interrumpido' : 'Listo'} en ${formatDuration(r.durationMs)} · ${parts.join(' · ')}`
}

async function setOn($: EngineInterface, value: boolean) {
  await update($, isOn, () => value)
  await $.store.set(STORE_KEY, value)
}

// Pide a Claude Code el desglose de /context, estimado en local (sin llamadas de conteo).
async function refreshContext($: EngineInterface) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (!b || !(b.rawMaxTokens > 0)) return
  await update($, reading, () => toReading(b))
}

async function toggleCompact($: EngineInterface, section: keyof Compact) {
  const value = await update($, compact, c => ({ ...c, [section]: !c[section] }))
  await $.store.set(COMPACT_KEY, value).catch(() => {})
}

async function trackPlan($: EngineInterface, tool: string, e: object, ran: { result?: unknown }) {
  if (WORK_STATE_TOOL.test(tool)) {
    await update($, run, r => (r ? { ...r, plan: applyWorkState(r.plan, e) } : r))
  } else if (tool === 'TodoWrite') {
    const todos = (e as { todos?: { content: string; status: string }[] }).todos ?? []
    const plan = todos.map((t, i) => ({ id: String(i), label: t.content, status: todoStatus(t.status) }))
    await update($, run, r => (r ? { ...r, plan } : r))
  } else if (tool === 'TaskCreate') {
    const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
    const subject = field(e, 'subject')
    if (id && subject) {
      await update($, run, r => (r ? { ...r, plan: [...r.plan, { id, label: subject, status: 'pending' as StepStatus }] } : r))
    }
  } else if (tool === 'TaskUpdate') {
    const id = field(e, 'taskId')
    const status = field(e, 'status')
    const subject = field(e, 'subject')
    await update($, run, r => {
      if (!r || !id) return r
      const plan =
        status === 'deleted'
          ? r.plan.filter(s => s.id !== id)
          : r.plan.map(s =>
              s.id === id ? { ...s, label: subject ?? s.label, status: status ? todoStatus(status) : s.status } : s,
            )
      return { ...r, plan }
    })
  }
}

export const register: Register = on => {
  let ticker: Timer | undefined

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const stored = await $.store.get(STORE_KEY).catch(() => undefined)
    if (typeof stored === 'boolean') await update($, isOn, () => stored)
    const folded = (await $.store.get(COMPACT_KEY).catch(() => undefined)) as Partial<Compact> | undefined
    if (folded && typeof folded === 'object') {
      await update($, compact, () => ({ progress: folded.progress === true, context: folded.context === true }))
    }
    await $.command
      .register({ name: 'clean-bar', description: 'Activa o desactiva Clean Bar (on | off | sin argumento para alternar)', immediate: true })
      .catch(() => {})
    void refreshContext($).catch(() => {})
    return r
  })

  // Un /compact vacía la ventana sin que termine un turno.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && 'messages' in r) void refreshContext($).catch(() => {})
    return r
  })

  on('command.run', { command: 'clean-bar' }, async ($, e) => {
    const arg = String((e as { args?: unknown }).args ?? '').trim().toLowerCase()
    const value = arg === 'on' ? true : arg === 'off' ? false : !(await read($, isOn))
    await setOn($, value)
    return { text: `Clean Bar ${value ? 'activado' : 'desactivado'}.` }
  })

  // Cada turno del bucle principal empieza una ejecución nueva; una continuación conserva el título.
  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    const title = e.text.trim() || undefined
    await update($, run, r => ({ ...emptyRun(now), title: title ?? r?.title }))
    ticker ??= $.clock.every(FRAME_MS, () => void update($, frame, f => f + 1).catch(() => {}))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const tool = String(e.tool)
    if (PLAN_TOOLS.has(tool) || WORK_STATE_TOOL.test(tool)) {
      const ran = await next(e)
      await trackPlan($, tool, e, ran).catch(() => {}) // el seguimiento nunca bloquea la herramienta
      return ran
    }

    const activity: Step = { id: e.tool_use_id, label: describeCall(tool, e), status: 'running' }
    await update($, run, r => (r ? { ...r, activity, toolCalls: r.toolCalls + 1 } : r)).catch(() => {})

    const ran = await next(e)
    const isFailed = ran.deny !== undefined || (ran as { isError?: boolean }).isError === true
    const file = field(e, 'file_path') ?? field(e, 'notebook_path')

    await update($, run, r => {
      if (!r) return r
      // Llamadas en paralelo: solo se cierra la actividad si sigue siendo esta.
      const status: StepStatus = isFailed ? 'error' : 'done'
      const changedFiles =
        !isFailed && EDIT_TOOLS.has(tool) && file && !r.changedFiles.includes(file) ? [...r.changedFiles, file] : r.changedFiles
      return {
        ...r,
        activity: r.activity?.id === activity.id ? { ...activity, status } : r.activity,
        changedFiles,
        commands: r.commands + (tool === 'Bash' ? 1 : 0),
        errors: r.errors + (isFailed ? 1 : 0),
      }
    }).catch(() => {})
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      ticker?.cancel()
      ticker = undefined
      const now = await $.clock.now()
      await update($, run, r =>
        r ? { ...r, isWorking: false, durationMs: e.durationMs || now - r.startedAt, isAborted: e.isAborted } : r,
      )
    }
    const result = await next(e)
    if (e.agentId === undefined) await refreshContext($).catch(() => {}) // un subagente llena su propia ventana
    return result
  })

  // Oculta las filas técnicas mientras está activo (ctrl+o sigue mostrando todo).
  on('ui.render', { component: HIDDEN_ROWS }, async ($, e, next) => {
    const isExpanded = (e.props as { isExpanded?: boolean }).isExpanded === true
    if (isExpanded || !(await read($, isOn))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // lo que dibujan otros mods y Claude Code se queda debajo
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return rest
    const { Box, Text, Button } = $.ui.resolve(e)
    const active = await read($, isOn)

    const toggle = (
      <Button key="toggle" hotkey={TOGGLE_HOTKEY} plain label={active ? 'ocultar' : 'Activar Clean Bar'} onPress={() => setOn($, !active)} />
    )
    if (!active) {
      return (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>Clean Bar desactivado · </Text>
            {toggle}
          </Box>
          {rest}
        </Box>
      )
    }

    const inner = e.props.bodyColumns - 4 // el borde y el relleno ocupan 4 celdas
    if (inner < MIN_WIDTH) return rest
    const r = await read($, run)
    const ctx = await read($, reading)
    const now = await $.clock.now()
    const folded = await read($, compact)
    const n = await read($, frame)

    const fold = (section: keyof Compact) => (
      <Button
        key={`fold-${section}`}
        hotkey={FOLD_HOTKEY[section]}
        plain
        label={folded[section] ? '▸' : '▾'}
        onPress={() => toggleCompact($, section)}
      />
    )

    // Una fila de sección: rombo, nombre y botones, lo que quepa a la izquierda; a la derecha el dato.
    const row = (title: string, buttons: RenderChildren, left: RenderChildren, right: RenderChildren) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" flexShrink={1}>
          <Text color={ACCENT}>{'◆ '}</Text>
          <Text bold>{`${title} `}</Text>
          {buttons}
          <Text wrap="truncate-end">{left}</Text>
        </Box>
        <Text wrap="truncate-start">{right}</Text>
      </Box>
    )
    const badge = (percent: number, tone: string) => (
      <Text bold color="black" backgroundColor={tone}>{` ${percent}% `}</Text>
    )

    const progressSection = () => {
      const buttons = (
        <Box flexDirection="row">
          {fold('progress')}
          <Text> </Text>
          {toggle}
          <Text> </Text>
        </Box>
      )
      if (!r) return row('clean view', buttons, null, <Text dimColor>esperando una tarea</Text>)
      const hasPlan = r.plan.length > 0
      const { done, total, percent } = progress(r.plan)
      const current = currentTask(r.plan)
      const elapsed = formatDuration(r.isWorking ? now - r.startedAt : r.durationMs)
      const isClean = r.errors === 0 && !r.isAborted
      const tone = r.isWorking ? ACCENT : isClean ? OK : WARN
      const position = current && r.isWorking ? current.index + 1 : done
      const steps = `${r.toolCalls} ${r.toolCalls === 1 ? 'paso' : 'pasos'}`

      if (folded.progress) {
        // Una línea: lo que se hace ahora (o el resumen) y, a la derecha, mini barra y porcentaje.
        const doing = r.isWorking ? (current?.step ?? r.activity) : undefined
        const left = r.isWorking ? (
          doing ? (
            <Text>
              <Text color={COLOR[doing.status]}>{`${ICON[doing.status]} `}</Text>
              <Text>{doing.label}</Text>
            </Text>
          ) : (
            <Text dimColor>Pensando…</Text>
          )
        ) : (
          <Text color={tone}>{`${isClean ? '✓' : '!'} ${summarize(r)}`}</Text>
        )
        const mini = bar(percent, MINI_BAR)
        const right = hasPlan ? (
          <Text>
            <Text color={tone}>{mini.filled}</Text>
            <Text color={TRACK}>{mini.empty}</Text>
            <Text dimColor>{` ${position}/${total} `}</Text>
            {badge(percent, tone)}
          </Text>
        ) : (
          <Text dimColor>{` ${steps} · ${elapsed}`}</Text>
        )
        return row('clean view', buttons, left, right)
      }

      // Cabecera: el prompt a la izquierda y el tiempo a la derecha.
      const header = row('clean view', buttons, r.title && <Text bold color={ACCENT}>{clip(r.title, inner)}</Text>, (
        <Text dimColor>{elapsed}</Text>
      ))
      const stepLabel = `Paso ${position} de ${total} `
      const pct = ` ${percent}%`
      const width = Math.max(1, inner - stepLabel.length - pct.length)
      const filled = Math.round((percent / 100) * width)
      const planBar = (
        <Text wrap="truncate-end">
          <Text dimColor>{stepLabel}</Text>
          {Array.from({ length: filled }, (_, k) => (
            <Text color={r.isWorking ? mix(ACCENT, PINK, k / Math.max(1, width - 1)) : tone}>█</Text>
          ))}
          <Text color={TRACK}>{'─'.repeat(width - filled)}</Text>
          <Text bold color={tone}>{pct}</Text>
        </Text>
      )

      // Solo lo que está en curso: las tareas del plan, o la acción si ninguna lo está.
      const running = r.plan.filter(s => s.status === 'running')
      const active = running.length > 0 ? running : r.activity?.status === 'running' ? [r.activity] : []
      const labelWidth = Math.max(8, inner - WORK_BAR - STATUS_LABEL.length - 2)
      const size = Math.max(3, Math.round(WORK_BAR / 3))
      const start = sweep(n, WORK_BAR, size)
      const workBar = (
        <Text>
          {Array.from({ length: WORK_BAR }, (_, k) => {
            const isLit = k >= start && k < start + size
            return isLit ? (
              <Text color={mix(ACCENT, PINK, (k - start + 1) / size)}>█</Text>
            ) : (
              <Text color={TRACK}>─</Text>
            )
          })}
        </Text>
      )

      return (
        <Box flexDirection="column">
          {header}
          {hasPlan ? planBar : <Text dimColor>{steps}</Text>}
          {r.isWorking &&
            active.map(step => (
              <Box flexDirection="row">
                <Box width={labelWidth} flexShrink={0}>
                  <Text wrap="truncate-end">
                    <Text color={PINK}>{'● '}</Text>
                    <Text bold>{step.label}</Text>
                  </Text>
                </Box>
                <Text> </Text>
                {workBar}
                <Text bold color={PINK}>{` ${STATUS_LABEL}`}</Text>
              </Box>
            ))}
          {r.isWorking && active.length === 0 && <Text dimColor>Pensando…</Text>}
          {!r.isWorking && (
            <Text color={tone} wrap="wrap">
              {`${isClean ? '✓' : '!'} ${summarize(r)}`}
            </Text>
          )}
        </Box>
      )
    }

    const contextSection = (c: Reading) => {
      const used = `${tokens(c.total)} de ${tokens(c.window)}`
      const level = c.compactsAt ? c.total / c.compactsAt : c.total / c.window
      const tone = level >= 0.9 ? 'red' : level >= 0.7 ? 'yellow' : 'green'
      const buttons = (
        <Box flexDirection="row">
          {fold('context')}
          <Text> </Text>
        </Box>
      )
      const stacked = (width: number) => (
        <Text>
          {cells(c, width).map(cell => (
            <Text color={cell.color}>{cell.text}</Text>
          ))}
        </Text>
      )

      if (folded.context) {
        return row('context', buttons, null, (
          <Text>
            {stacked(MINI_BAR)}
            <Text dimColor>{` ${used} `}</Text>
            {badge(c.percent, tone)}
          </Text>
        ))
      }

      const info = `${used}${c.compactsAt ? ` · compacta en ${tokens(c.compactsAt)}` : ''}`
      return (
        <Box flexDirection="column">
          {row('context', buttons, null, (
            <Text>
              <Text dimColor>{`${info} `}</Text>
              {badge(c.percent, tone)}
            </Text>
          ))}
          {stacked(inner)}
          {legend(c, inner).map(line => (
            <Text wrap="truncate-end">
              {line.map((sl, i) => (
                <Text>
                  {i > 0 && <Text>{SPLIT}</Text>}
                  <Text color={sl.color}>{sl.kind === 'used' ? '■ ' : `${GLYPH[sl.kind]} `}</Text>
                  <Text dimColor={sl.kind !== 'used'}>{`${sl.name} `}</Text>
                  <Text bold={sl.kind === 'used'}>{tokens(sl.tokens)}</Text>
                  {sl.kind === 'used' && <Text dimColor>{` ${share(sl.tokens, c.window)}`}</Text>}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      )
    }

    // Separación entre secciones solo cuando la de arriba ocupa varias líneas.
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
          {progressSection()}
          {ctx && <Box marginTop={folded.progress ? 0 : 1}>{contextSection(ctx)}</Box>}
        </Box>
        {rest}
      </Box>
    )
  })
}
