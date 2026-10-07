// Clean Bar: Clean View y Context Bar en una sola caja sobre el prompt.
//   Arriba, el progreso: la tarea en curso, una barra del plan y su porcentaje (sin plan,
//   solo la actividad). Debajo, la ventana de contexto: barra apilada por categoría y leyenda.
//   Oculta las filas de herramientas. Se alterna con `0` (prompt vacío), el botón o /clean-bar.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Reading, Run, Step, StepStatus } from '../types'
import { GLYPH, SPLIT, cells, legend, share, toReading, tokens } from './context'

const isOn = atom({ plugin: 'clean-bar', key: 'isOn' } as const, true)
const run = atom({ plugin: 'clean-bar', key: 'run' } as const, null as Run | null)
const reading = atom({ plugin: 'clean-bar', key: 'reading' } as const, null as Reading | null)

const STORE_KEY = 'isOn'
const TOGGLE_HOTKEY = '0'
const MIN_WIDTH = 20
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const HIDDEN_ROWS = ['ToolUse', 'ToolResult', 'ToolGroup', 'ToolProgress'] as const

const ACCENT = '#d97757'
const OK = '#9ece6a'
const WARN = '#e0af68'
const TRACK = '#808080'
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
  return status === 'completed' ? 'done' : status === 'in_progress' ? 'running' : 'pending'
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

async function trackPlan($: EngineInterface, tool: string, e: object, ran: { result?: unknown }) {
  if (tool === 'TodoWrite') {
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
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const stored = await $.store.get(STORE_KEY).catch(() => undefined)
    if (typeof stored === 'boolean') await update($, isOn, () => stored)
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

  // Cada turno del bucle principal empieza una ejecución nueva.
  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, run, () => emptyRun(now))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const tool = String(e.tool)
    if (PLAN_TOOLS.has(tool)) {
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

    // Cabecera de cada sección: rombo, nombre, y a la derecha el dato y su porcentaje.
    const header = (title: string, info: string, percent: number | undefined, tone: string, extra?: RenderChildren) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text color={ACCENT}>{'◆ '}</Text>
          <Text bold>{`${title} `}</Text>
          {extra}
        </Box>
        <Text wrap="truncate-start">
          <Text dimColor>{`${info} `}</Text>
          {percent !== undefined && <Text bold color="black" backgroundColor={tone}>{` ${percent}% `}</Text>}
        </Text>
      </Box>
    )

    const progressSection = () => {
      if (!r) return header('clean view', 'esperando una tarea', undefined, ACCENT, toggle)
      const hasPlan = r.plan.length > 0
      const { done, total, percent } = progress(r.plan)
      const current = currentTask(r.plan)
      const elapsed = formatDuration(r.isWorking ? now - r.startedAt : r.durationMs)
      const isClean = r.errors === 0 && !r.isAborted
      const tone = r.isWorking ? ACCENT : isClean ? OK : WARN
      const info = hasPlan
        ? `tarea ${current && r.isWorking ? current.index + 1 : done} de ${total} · ${elapsed}`
        : `${r.toolCalls} ${r.toolCalls === 1 ? 'paso' : 'pasos'} · ${elapsed}`
      const { filled, empty } = bar(percent, inner)
      return (
        <Box flexDirection="column">
          {header('clean view', info, hasPlan ? percent : undefined, tone, toggle)}
          {hasPlan && (
            <Text>
              <Text color={tone}>{filled}</Text>
              <Text color={TRACK}>{empty}</Text>
            </Text>
          )}
          {r.isWorking && current && (
            <Text wrap="truncate-end">
              <Text color={COLOR[current.step.status]}>{`${ICON[current.step.status]} `}</Text>
              <Text bold>{current.step.label}</Text>
            </Text>
          )}
          {r.isWorking && r.activity && (
            <Text wrap="truncate-end">
              <Text color={COLOR[r.activity.status]}>{hasPlan ? '  ↳ ' : `${ICON[r.activity.status]} `}</Text>
              <Text dimColor={hasPlan}>{r.activity.label}</Text>
            </Text>
          )}
          {r.isWorking && !current && !r.activity && <Text dimColor>Pensando…</Text>}
          {!r.isWorking && (
            <Text color={tone} wrap="wrap">
              {`${isClean ? '✓' : '!'} ${summarize(r)}`}
            </Text>
          )}
        </Box>
      )
    }

    const contextSection = (c: Reading) => {
      const info = `${tokens(c.total)} de ${tokens(c.window)}${c.compactsAt ? ` · compacta en ${tokens(c.compactsAt)}` : ''}`
      const level = c.compactsAt ? c.total / c.compactsAt : c.total / c.window
      const tone = level >= 0.9 ? 'red' : level >= 0.7 ? 'yellow' : 'green'
      return (
        <Box flexDirection="column" marginTop={1}>
          {header('context', info, c.percent, tone)}
          <Text>
            {cells(c, inner).map(cell => (
              <Text color={cell.color}>{cell.text}</Text>
            ))}
          </Text>
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

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
          {progressSection()}
          {ctx && contextSection(ctx)}
        </Box>
        {rest}
      </Box>
    )
  })
}
