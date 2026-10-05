import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run, Step, StepStatus } from '../types'

const isOn = atom({ plugin: 'clean-view', key: 'isOn' } as const, true)
const run = atom({ plugin: 'clean-view', key: 'run' } as const, null)

const STORE_KEY = 'isOn'
/** Un dígito: en la banda también funciona escribiéndolo solo en el prompt vacío. */
const TOGGLE_HOTKEY = '0'
const MODE_LABEL = 'clean view'
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

const ICON: Record<StepStatus, string> = { pending: '○', running: '◐', done: '✓', error: '✗' }
const COLOR: Record<StepStatus, string | undefined> = {
  pending: undefined,
  running: 'yellow',
  done: 'green',
  error: 'red',
}

const emptyRun = (startedAt: number): Run => ({
  isWorking: true,
  startedAt,
  durationMs: 0,
  steps: [],
  plan: [],
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

function progressBar(done: number, total: number, width: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
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
  const head = r.isAborted ? 'Interrumpido' : 'Listo'
  return `${head} en ${formatDuration(r.durationMs)} · ${parts.join(' · ')}`
}

async function setOn($: EngineInterface, value: boolean) {
  await update($, isOn, () => value)
  await $.store.set(STORE_KEY, value)
}

async function shouldHide($: EngineInterface, props: object): Promise<boolean> {
  const isExpanded = (props as { isExpanded?: boolean }).isExpanded === true
  return !isExpanded && (await read($, isOn))
}

async function trackPlan($: EngineInterface, tool: string, e: object, ran: { result?: unknown }) {
  if (tool === 'TodoWrite') {
    const todos = (e as { todos?: { content: string; status: string }[] }).todos ?? []
    const plan = todos.map((t, i) => ({ id: String(i), label: t.content, status: todoStatus(t.status) }))
    await update($, run, (r: Run | null) => (r ? { ...r, plan } : r))
  } else if (tool === 'TaskCreate') {
    const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
    const subject = field(e, 'subject')
    if (id && subject) {
      await update($, run, (r: Run | null) =>
        r ? { ...r, plan: [...r.plan, { id, label: subject, status: 'pending' as StepStatus }] } : r,
      )
    }
  } else if (tool === 'TaskUpdate') {
    const id = field(e, 'taskId')
    const status = field(e, 'status')
    const subject = field(e, 'subject')
    await update($, run, (r: Run | null) => {
      if (!r || !id) return r
      const plan =
        status === 'deleted'
          ? r.plan.filter(s => s.id !== id)
          : r.plan.map(s =>
              s.id === id
                ? { ...s, label: subject ?? s.label, status: status ? todoStatus(status) : s.status }
                : s,
            )
      return { ...r, plan }
    })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_KEY)
    if (typeof stored === 'boolean') await update($, isOn, () => stored)
    await $.command.register({
      name: 'clean-view',
      description: 'Activa o desactiva Clean View (on | off | sin argumento para alternar)',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'clean-view' }, async ($, e) => {
    const arg = String((e as { args?: unknown }).args ?? '').trim().toLowerCase()
    const current = await read($, isOn)
    const value = arg === 'on' ? true : arg === 'off' ? false : !current
    await setOn($, value)
    return { text: `Clean View ${value ? 'activado' : 'desactivado'}.` }
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
      await trackPlan($, tool, e, ran)
      return ran
    }

    const step: Step = { id: e.tool_use_id, label: describeCall(tool, e), status: 'running' }
    await update($, run, r => (r ? { ...r, steps: [...r.steps, step] } : r))

    const ran = await next(e)
    const isFailed = ran.deny !== undefined || (ran as { isError?: boolean }).isError === true
    const file = field(e, 'file_path') ?? field(e, 'notebook_path')

    await update($, run, r => {
      if (!r) return r
      const steps = r.steps.map(s => (s.id === step.id ? { ...s, status: isFailed ? 'error' : 'done' } as Step : s))
      const changedFiles =
        !isFailed && EDIT_TOOLS.has(tool) && file && !r.changedFiles.includes(file)
          ? [...r.changedFiles, file]
          : r.changedFiles
      return {
        ...r,
        steps,
        changedFiles,
        commands: r.commands + (tool === 'Bash' ? 1 : 0),
        errors: r.errors + (isFailed ? 1 : 0),
      }
    })
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    let finished: Run | null = null
    await update($, run, r => {
      if (!r) return r
      finished = { ...r, isWorking: false, durationMs: e.durationMs || now - r.startedAt, isAborted: e.isAborted }
      return finished
    })
    const r = finished as Run | null
    const result = await next(e)
    // Un `text` distinto de la respuesta se muestra como una línea bajo ella.
    if (r && r.steps.length > 0 && (await read($, isOn))) {
      return { ...result, text: `Clean View · ${summarize(r)}` }
    }
    return result
  })

  // Oculta las filas técnicas mientras el modo está activo (ctrl+o sigue mostrando todo).
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await shouldHide($, e.props))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await shouldHide($, e.props))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await shouldHide($, e.props))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await shouldHide($, e.props))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // Progreso junto al spinner: «Pensando · paso 3/5…»
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    const r = await read($, run)
    const { done, total } = countProgress(visibleSteps(r))
    if (!r?.isWorking || total === 0) return next(e)
    const current = Math.min(done + 1, total)
    return next({ ...e, props: { ...e.props, suffix: ` · paso ${current}/${total}…` } })
  })

  // Etiqueta en el pie del prompt mientras el modo está activo.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, MODE_LABEL] } })
  })

  // La barra: interruptor, pasos con su estado, progreso y resumen.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const active = await read($, isOn)
    // La banda es de todos los mods: lo que dibujen los demás va debajo del nuestro.
    const theirs = await next(e)

    const toggle = (
      <Button
        key="toggle"
        hotkey={TOGGLE_HOTKEY}
        plain
        label={active ? 'Desactivar' : 'Activar Clean View'}
        onPress={() => setOn($, !active)}
      />
    )

    if (!active) {
      return (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>Clean View desactivado · </Text>
            {toggle}
          </Box>
          {theirs}
        </Box>
      )
    }

    const r = await read($, run)
    const steps = visibleSteps(r)
    const { done, total } = countProgress(steps)
    const width = Math.max(10, Math.min(30, e.props.bodyColumns - 40))
    const room = Math.max(1, Math.min(8, e.props.maxRows - 3))
    const shown = r?.isWorking ? windowAroundCurrent(steps, room) : steps.slice(-room)

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color="cyan">Clean View </Text>
          {r && total > 0 && (
            <Text>
              <Text color={r.isWorking ? 'yellow' : 'green'}>{progressBar(done, total, width)}</Text>
              <Text dimColor> {done}/{total} </Text>
            </Text>
          )}
          {!r && <Text dimColor>esperando una tarea · </Text>}
          {r && <Text dimColor>· </Text>}
          {toggle}
        </Box>
        {shown.length < steps.length && (
          <Text dimColor>  … {steps.length - shown.length} pasos más</Text>
        )}
        {shown.map(s => (
          <Text wrap="truncate-end">
            <Text color={COLOR[s.status]} dimColor={s.status === 'pending'}>  {ICON[s.status]} </Text>
            <Text dimColor={s.status === 'done'}>{s.label}</Text>
          </Text>
        ))}
        {r && !r.isWorking && (
          <Text color={r.errors > 0 || r.isAborted ? 'yellow' : 'green'} wrap="wrap">
            {summarize(r)}
          </Text>
        )}
        {theirs}
      </Box>
    )
  })
}

/** El plan del modelo si lo hay; si no, los pasos de las llamadas. */
function visibleSteps(r: Run | null): Step[] {
  return r ? (r.plan.length > 0 ? r.plan : r.steps) : []
}

function countProgress(steps: Step[]): { done: number; total: number } {
  const done = steps.filter(s => s.status === 'done' || s.status === 'error').length
  return { done, total: steps.length }
}

/** Mientras trabaja, muestra la ventana de pasos que incluye el actual. */
function windowAroundCurrent(steps: Step[], room: number): Step[] {
  if (steps.length <= room) return steps
  const current = steps.findIndex(s => s.status === 'running')
  const anchor = current === -1 ? steps.length - 1 : current
  const start = Math.max(0, Math.min(anchor - Math.floor(room / 2), steps.length - room))
  return steps.slice(start, start + room)
}
