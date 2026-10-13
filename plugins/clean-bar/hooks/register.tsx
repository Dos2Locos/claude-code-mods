// Clean Bar: Clean View y Context Bar en una sola caja sobre el prompt.
//   Una sola línea: el progreso (tarea en curso, mini barra y porcentaje), el contexto
//   (mini barra apilada y porcentaje) y la vida de la caché de prompts (cuenta atrás desde la
//   última petición). Pulsar una sección, o `1`, `2` y `3` (prompt vacío), despliega su detalle.
//   Oculta las filas de herramientas. Se alterna con `0` (prompt vacío), el botón o /clean-bar.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Cache, Reading, Run, Section, Step, StepStatus } from '../types'
import { GLYPH, SPLIT, cells, fromTotals, legend, share, toReading, tokens } from './context'

const isOn = atom({ plugin: 'clean-bar', key: 'isOn' } as const, true)
const run = atom({ plugin: 'clean-bar', key: 'run' } as const, null as Run | null)
const reading = atom({ plugin: 'clean-bar', key: 'reading' } as const, null as Reading | null)
const open = atom({ plugin: 'clean-bar', key: 'open' } as const, null as Section | null)
const cache = atom({ plugin: 'clean-bar', key: 'cache' } as const, null as Cache | null)

const STORE_KEY = 'isOn'
const TOGGLE_HOTKEY = '0'
const SECTION_HOTKEY: Record<Section, string> = { progress: '1', context: '2', cache: '3' }
const MINUTE = 60_000
const CACHE_TTL_MS: Record<string, number> = { '5m': 5 * MINUTE, '1h': 60 * MINUTE }
/** Cada cuánto se redibuja la cuenta atrás mientras la caché está caliente. */
const TICK_MS = 1000
/** Ancho de las mini barras de cada tarea en el detalle. */
const MINI_BAR = 16
/** Ancho de las barras de la línea. */
const LINE_BAR = 10
const GAP = '  '
/** Lo que ocupa un botón `plain` con atajo antes de su texto: `1: `. */
const HOTKEY_WIDTH = 3
const MIN_LABEL = 8

/** El temporizador de la cuenta atrás; una recarga del módulo arranca otro. */
let ticker: { cancel: () => void } | undefined
const MIN_WIDTH = 20
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
/** La lista de trabajo de claude-mem (`work_state_write`), con el prefijo MCP que tenga instalado. */
const WORK_STATE_TOOL = /work_state_write$/
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const HIDDEN_ROWS = ['ToolUse', 'ToolResult', 'ToolGroup', 'ToolProgress'] as const

const ACCENT = '#d97757'
const OK = '#9ece6a'
const WARN = '#e0af68'
const TRACK = '#808080'
// Degradados del plan: naranja a rosa mientras trabaja, verdes al terminar.
const ORANGE = '#ff9e64'
const PINK = '#ff5f87'
const GREEN_FROM = '#2f9e44'
const GREEN_TO = '#9ece6a'
const SHADE = '#3b4252' // el fondo de las barras vacías
/** Tareas del plan visibles a la vez, alrededor de la actual. */
const MAX_ROWS = 6
/** Parte de la mini barra que llena la tarea en curso (no hay progreso real por tarea). */
const RUNNING_SHARE = 0.4
const ICON: Record<StepStatus, string> = { pending: '○', running: '◐', done: '✓', error: '✗' }
const COLOR: Record<StepStatus, string | undefined> = { pending: undefined, running: ACCENT, done: OK, error: 'red' }

const emptyRun = (startedAt: number, title: string): Run => ({
  isWorking: true,
  title,
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

/** Mezcla dos colores `#rrggbb`: `t` 0 da `a`, 1 da `b`. */
export function mix(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2]
    .map(i => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t).toString(16).padStart(2, '0'))
    .join('')}`
}

/** El estado de cada tarea en palabras; la primera pendiente es «Siguiente». */
export function stepState(plan: Step[], index: number): string {
  const status = plan[index]!.status
  if (status !== 'pending') return { done: 'Hecho', running: 'En curso', error: 'Error' }[status]
  return plan.findIndex(s => s.status === 'pending') === index ? 'Siguiente' : 'Pendiente'
}

/** Qué tramo del plan cabe: hasta `max` tareas, con la anterior a la actual arriba. */
export function visibleRange(total: number, focus: number, max: number): { start: number; end: number } {
  const start = Math.min(Math.max(focus - 1, 0), Math.max(total - max, 0))
  return { start, end: Math.min(total, start + max) }
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

/** Cuenta atrás compacta: `42:13`. */
export function countdown(ms: number): string {
  const seconds = Math.max(Math.ceil(ms / 1000), 0)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Lo que le queda a la caché, de 0 a 1, y su color: verde, amarillo al 50 % y rojo al 20 %. */
export function cacheLife(c: Cache, now: number, ttl: number): { left: number; share: number; tone: string } {
  const left = Math.max(c.at + ttl - now, 0)
  const share = left / ttl
  return { left, share, tone: share > 0.5 ? 'green' : share > 0.2 ? 'yellow' : 'red' }
}

async function setOn($: EngineInterface, value: boolean) {
  await update($, isOn, () => value)
  await $.store.set(STORE_KEY, value)
}

// Pide a Claude Code el desglose de /context, estimado en local (sin llamadas de conteo).
async function refreshContext($: EngineInterface) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const { breakdown: b, tokens: total, window, percent } = usage.context
  if (b && b.rawMaxTokens > 0) await update($, reading, () => toReading(b))
  else if (total !== undefined && window > 0) await update($, reading, () => fromTotals(total, window, percent))
}

async function toggleSection($: EngineInterface, section: Section) {
  await update($, open, current => (current === section ? null : section))
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

export const register: Register = (on, options) => {
  const ttl = CACHE_TTL_MS[String(options.cacheTtl)] ?? CACHE_TTL_MS['1h']!

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const stored = await $.store.get(STORE_KEY).catch(() => undefined)
    if (typeof stored === 'boolean') await update($, isOn, () => stored)
    await $.command
      .register({ name: 'clean-bar', description: 'Activa o desactiva Clean Bar (on | off | sin argumento para alternar)', immediate: true })
      .catch(() => {})
    void refreshContext($).catch(() => {})
    // Redibuja la cuenta atrás cada segundo mientras la caché vive (y una vez más al caducar).
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      void (async () => {
        const c = await read($, cache)
        if (c && (await $.clock.now()) - c.at <= ttl + TICK_MS) $.ui.invalidate('ui.render')
      })().catch(() => {})
    })
    return r
  })

  // Cada petición del hilo principal renueva su caché de prompts.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (e.agentId === undefined && usage) {
      const at = await $.clock.now()
      await update($, cache, () => ({
        at,
        read: usage.cache_read_input_tokens,
        write: usage.cache_creation_input_tokens,
        uncached: usage.input_tokens,
      })).catch(() => {})
    }
    return result
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

  // Cada turno del bucle principal empieza una ejecución nueva.
  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, run, () => emptyRun(now, e.text))
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

    const toggleLabel = active ? 'ocultar' : 'Activar Clean Bar'
    const toggle = (
      <Button key="toggle" hotkey={TOGGLE_HOTKEY} plain label={toggleLabel} onPress={() => setOn($, !active)} />
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

    const width = e.props.bodyColumns
    if (width < MIN_WIDTH) return rest
    const r = await read($, run)
    const ctx = await read($, reading)
    const now = await $.clock.now()
    const opened = await read($, open)
    const lastCall = await read($, cache)
    const inner = width - 4 // el borde y el relleno del detalle ocupan 4 celdas

    const badge = (percent: number, tone: string) => (
      <Text bold color="black" backgroundColor={tone}>{` ${percent}% `}</Text>
    )
    const blocks = (count: number, size: number, a: string, b: string) => (
      <Text>
        {Array.from({ length: size }, (_, i) => (
          <Text color={i < count ? mix(a, b, count > 1 ? i / (count - 1) : 1) : SHADE}>█</Text>
        ))}
      </Text>
    )
    const stacked = (c: Reading, size: number) => (
      <Text>
        {cells(c, size).map(cell => (
          <Text color={cell.color}>{cell.text}</Text>
        ))}
      </Text>
    )
    // Cada sección de la línea es un botón que despliega o recoge su detalle.
    const section = (s: Section, children: RenderChildren) => (
      <Button key={`fold-${s}`} hotkey={SECTION_HOTKEY[s]} plain onPress={() => toggleSection($, s)}>
        <Text color={ACCENT}>{opened === s ? '▾ ' : '▸ '}</Text>
        {children}
      </Button>
    )

    // Estado del turno, compartido por la línea y el detalle.
    const hasPlan = (r?.plan.length ?? 0) > 0
    const { done, total, percent } = progress(r?.plan ?? [])
    const current = currentTask(r?.plan ?? [])
    const elapsed = r ? formatDuration(r.isWorking ? now - r.startedAt : r.durationMs) : ''
    const isClean = r ? r.errors === 0 && !r.isAborted : true
    const tone = r?.isWorking ? ACCENT : isClean ? OK : WARN
    const position = current && r?.isWorking ? current.index + 1 : done
    const steps = r ? `${r.toolCalls} ${r.toolCalls === 1 ? 'paso' : 'pasos'}` : ''
    const [from, to] = r?.isWorking ? [ORANGE, PINK] : isClean ? [GREEN_FROM, GREEN_TO] : [ORANGE, WARN]
    const summary = r ? `${isClean ? '✓' : '!'} ${summarize(r)}` : ''

    // La línea: lo que no es la etiqueta de progreso tiene ancho fijo; la etiqueta se recorta al resto.
    const used = ctx ? `${tokens(ctx.total)}/${tokens(ctx.window)}` : ''
    const level = ctx ? ctx.total / (ctx.compactsAt ?? ctx.window) : 0
    const ctxTone = level >= 0.9 ? 'red' : level >= 0.7 ? 'yellow' : 'green'
    const progressRight = hasPlan ? `${'█'.repeat(LINE_BAR)} ${position}/${total}  ${percent}% ` : ` ${steps} · ${elapsed}`
    const life = lastCall ? cacheLife(lastCall, now, ttl) : undefined
    const cacheText = !life ? '◷ —' : life.left > 0 ? `◷ ${'█'.repeat(LINE_BAR)} ${countdown(life.left)}` : '◷ fría'
    const contextWidth = GAP.length + HOTKEY_WIDTH + 2 + (ctx ? LINE_BAR + ` ${used}  ${ctx.percent}% `.length : 'contexto …'.length)
    const cacheWidth = GAP.length + HOTKEY_WIDTH + 2 + cacheText.length
    const toggleWidth = GAP.length + HOTKEY_WIDTH + toggleLabel.length
    const labelWidth = Math.max(
      width - HOTKEY_WIDTH - 2 - progressRight.length - contextWidth - cacheWidth - toggleWidth,
      MIN_LABEL,
    )

    const progressLine = () => {
      if (!r) return <Text dimColor>esperando una tarea</Text>
      const doing = r.isWorking ? (current?.step ?? r.activity) : undefined
      const left = !r.isWorking ? (
        <Text color={tone}>{clip(summary, labelWidth)}</Text>
      ) : doing ? (
        <Text>
          <Text color={COLOR[doing.status]}>{`${ICON[doing.status]} `}</Text>
          <Text>{clip(doing.label, labelWidth - 2)}</Text>
        </Text>
      ) : (
        <Text dimColor>Pensando…</Text>
      )
      if (!hasPlan) return <Text>{left}<Text dimColor>{` ${steps} · ${elapsed}`}</Text></Text>
      const mini = bar(percent, LINE_BAR)
      return (
        <Text>
          {left}
          <Text> </Text>
          <Text color={tone}>{mini.filled}</Text>
          <Text color={TRACK}>{mini.empty}</Text>
          <Text dimColor>{` ${position}/${total} `}</Text>
          {badge(percent, tone)}
        </Text>
      )
    }

    const cacheLine = () => {
      if (!life) return <Text dimColor>◷ —</Text>
      if (life.left === 0) return <Text dimColor>◷ fría</Text>
      const drain = bar(life.share * 100, LINE_BAR)
      return (
        <Text>
          <Text color={life.tone}>{`◷ ${drain.filled}`}</Text>
          <Text color={TRACK}>{drain.empty}</Text>
          <Text bold color={life.tone}>{` ${countdown(life.left)}`}</Text>
        </Text>
      )
    }

    const cacheDetail = () => {
      if (!lastCall || !life) return <Text dimColor>Aún no hay peticiones al modelo en esta sesión.</Text>
      const isWarm = life.left > 0
      const ttlText = ttl >= 60 * MINUTE ? '1h' : `${Math.round(ttl / MINUTE)}m`
      const state = isWarm ? ` · caduca en ${formatDuration(life.left)}` : ' · la próxima petición la vuelve a escribir'
      const drain = bar(life.share * 100, inner)
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold color={isWarm ? life.tone : undefined} dimColor={!isWarm}>{isWarm ? 'Caché caliente' : 'Caché fría'}</Text>
            <Text dimColor>{`${state} (TTL ${ttlText}) · última petición hace ${formatDuration(now - lastCall.at)}`}</Text>
          </Text>
          <Text>
            <Text color={life.tone}>{drain.filled}</Text>
            <Text color={TRACK}>{drain.empty}</Text>
          </Text>
          <Text dimColor>
            {`Última petición: ${tokens(lastCall.read)} leídos de caché · ${tokens(lastCall.write)} escritos · ${tokens(lastCall.uncached)} sin caché`}
          </Text>
        </Box>
      )
    }

    const contextLine = (c: Reading | null) => !c ? <Text dimColor>contexto …</Text> : (
      <Text>
        {stacked(c, LINE_BAR)}
        <Text dimColor>{` ${used} `}</Text>
        {badge(c.percent, ctxTone)}
      </Text>
    )

    const progressDetail = () => {
      if (!r) return <Text dimColor>esperando una tarea</Text>
      const doneText = !r.isWorking && <Text color={tone} wrap="wrap">{summary}</Text>
      if (!hasPlan) {
        return (
          <Box flexDirection="column">
            <Text dimColor>{`${clip(r.title, inner) || 'clean view'} · ${steps} · ${elapsed}`}</Text>
            {r.isWorking && r.activity && <Text dimColor wrap="truncate-end">{`↳ ${r.activity.label}`}</Text>}
            {doneText}
          </Box>
        )
      }
      // Cabecera con el prompt, barra del plan y una fila por tarea con su mini barra.
      const title = clip(r.title, Math.max(inner - 24, MIN_WIDTH)) || 'clean view'
      const stepText = `Paso ${position} de ${total} `
      const pct = ` ${percent}%`
      const barWidth = Math.max(inner - stepText.length - pct.length, 0)
      const { start, end } = visibleRange(total, current?.index ?? total - 1, MAX_ROWS)
      const rowLabel = Math.min(Math.max(...r.plan.map(s => s.label.length)) + 2, Math.floor(inner * 0.45))
      const hidden = total - (end - start)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row" flexShrink={1}>
              <Text color={to}>{'✱ '}</Text>
              <Text bold wrap="truncate-end">
                {[...title].map((ch, i, all) => (
                  <Text color={mix(from, to, all.length > 1 ? i / (all.length - 1) : 0)}>{ch}</Text>
                ))}
              </Text>
            </Box>
            <Text dimColor>{elapsed}</Text>
          </Box>
          <Text wrap="truncate-end">
            <Text dimColor>{stepText}</Text>
            {blocks(Math.round((percent / 100) * barWidth), barWidth, from, to)}
            <Text bold color={to}>{pct}</Text>
          </Text>
          {r.plan.slice(start, end).map((s, k) => {
            const isRunning = s.status === 'running'
            const isPending = s.status === 'pending'
            const fill = isPending ? 0 : isRunning ? Math.round(MINI_BAR * RUNNING_SHARE) : MINI_BAR
            const [a, b] = s.status === 'done' ? [GREEN_FROM, GREEN_TO] : s.status === 'error' ? [WARN, 'red'] : [ORANGE, PINK]
            return (
              <Text wrap="truncate-end">
                <Text color={isRunning ? PINK : COLOR[s.status]}>{`${isRunning ? '●' : ICON[s.status]} `}</Text>
                <Text bold={isRunning} dimColor={isPending}>{clip(s.label, rowLabel - 2).padEnd(rowLabel)}</Text>
                {blocks(fill, MINI_BAR, a, b)}
                <Text bold={isRunning} color={isRunning ? PINK : undefined} dimColor={isPending}>
                  {` ${stepState(r.plan, start + k)}`}
                </Text>
              </Text>
            )
          })}
          {hidden > 0 && <Text dimColor>{`  … y ${hidden} ${hidden === 1 ? 'tarea' : 'tareas'} más`}</Text>}
          {r.isWorking && r.activity && <Text dimColor wrap="truncate-end">{`  ↳ ${r.activity.label}`}</Text>}
          {doneText}
        </Box>
      )
    }

    const contextDetail = (c: Reading) => (
      <Box flexDirection="column">
        <Text dimColor>{`${tokens(c.total)} de ${tokens(c.window)}${c.compactsAt ? ` · compacta en ${tokens(c.compactsAt)}` : ''}`}</Text>
        {stacked(c, inner)}
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

    const detail =
      opened === 'progress'
        ? progressDetail()
        : opened === 'context' && ctx
          ? contextDetail(ctx)
          : opened === 'cache'
            ? cacheDetail()
            : null
    const isPlanRunning = r?.isWorking === true && hasPlan
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" flexShrink={1}>
            {section('progress', progressLine())}
          </Box>
          <Box flexDirection="row">
            <Text>{GAP}</Text>
            {section('context', contextLine(ctx))}
            <Text>{GAP}</Text>
            {section('cache', cacheLine())}
            <Text>{GAP}</Text>
            {toggle}
          </Box>
        </Box>
        {detail && (
          <Box flexDirection="column" borderStyle="round" borderColor={isPlanRunning ? PINK : 'inactive'} paddingX={1}>
            {detail}
          </Box>
        )}
        {rest}
      </Box>
    )
  })
}
