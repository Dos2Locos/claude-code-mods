import { expect, mock, test } from 'claude-code/testing'

import { applyWorkState, bar, cacheLife, countdown, currentTask, mix, progress, stepState, visibleRange } from '../hooks/register'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const TOOL_ROW = {
  component: 'ToolUse',
  props: { tool_use_id: 'tu1', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false },
} as const

const PLAN = [
  { id: '0', label: 'Leer el código', status: 'done' as const },
  { id: '1', label: 'Arreglar el bug', status: 'running' as const },
  { id: '2', label: 'Correr las pruebas', status: 'pending' as const },
  { id: '3', label: 'Commit', status: 'pending' as const },
]

const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 3_400, color: 'promptBorder', kind: 'used', isDeferred: false },
    { name: 'MCP tools (deferred)', tokens: 40_000, color: 'inactive', kind: 'deferred', isDeferred: true },
    { name: 'Messages', tokens: 186_000, color: 'purple_FOR_SUBAGENTS_ONLY', kind: 'used', isDeferred: false },
    { name: 'Autocompact buffer', tokens: 50_000, color: 'inactive', kind: 'buffer', isDeferred: false },
    { name: 'Free space', tokens: 760_600, color: 'promptBorder', kind: 'free', isDeferred: false },
  ],
  totalTokens: 189_400,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 19,
  autoCompactThreshold: 950_000,
  isAutoCompactEnabled: true,
  gridRows: [],
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  model: 'opus',
  apiUsage: null,
  autocompactSource: 'model-default',
}

test('helpers', () => {
  expect(progress(PLAN)).toEqual({ done: 1, total: 4, percent: 25 })
  expect(currentTask(PLAN)?.step.label).toBe('Arreglar el bug')
  expect(currentTask(PLAN.map(s => ({ ...s, status: 'done' as const })))).toBeUndefined()
  expect(bar(50, 10)).toEqual({ filled: '█████', empty: '─────' })
  expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  expect(PLAN.map((_, i) => stepState(PLAN, i))).toEqual(['Hecho', 'En curso', 'Siguiente', 'Pendiente'])
  expect(visibleRange(10, 0, 6)).toEqual({ start: 0, end: 6 })
  expect(visibleRange(10, 5, 6)).toEqual({ start: 4, end: 10 })
  expect(visibleRange(10, 9, 6)).toEqual({ start: 4, end: 10 })
  expect(countdown(42 * 60_000 + 12_500)).toBe('42:13')
  expect(countdown(-5)).toBe('0:00')
  const call = { at: 0, read: 0, write: 0, uncached: 0 }
  expect(cacheLife(call, 15 * 60_000, 60 * 60_000)).toEqual({ left: 45 * 60_000, share: 0.75, tone: 'green' })
  expect(cacheLife(call, 50 * 60_000, 60 * 60_000).tone).toBe('red')
  expect(cacheLife(call, 2 * 60 * 60_000, 60 * 60_000).left).toBe(0)

  // work_state_write de claude-mem como plan
  const write = (task: string | undefined, status?: string) => ({ list: 'demo', fields: { ...(task ? { task } : {}), ...(status ? { status } : {}) } })
  let plan = applyWorkState([], write('A', 'todo'))
  plan = applyWorkState(plan, write('B'))
  plan = applyWorkState(plan, write('A', 'doing'))
  expect(plan.map(s => `${s.label}:${s.status}`)).toEqual(['A:running', 'B:pending'])
  plan = applyWorkState(plan, write('A', 'done'))
  plan = applyWorkState(plan, write('B', 'dropped'))
  expect(plan.map(s => `${s.label}:${s.status}`)).toEqual(['A:done'])
  expect(applyWorkState(plan, write(undefined, 'done'))).toEqual(plan) // cerrar la lista no toca las tareas
})

test('muestra el plan con su barra, porcentaje y estado por tarea; oculta las herramientas', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 189_400, window: 1_000_000, percent: 19, breakdown: BREAKDOWN }, rateLimits: {}, cost: { usd: 0 } },
  }) as never)
  on('ui.render', async ($, e) => $.ui.resolve(e).Text({ children: `engine ${e.component}` }))

  await $.turn.start({ text: 'arregla el bug', turnId: 't1' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Leer el código', status: 'completed', activeForm: 'Leyendo' },
      { content: 'Arreglar el bug', status: 'in_progress', activeForm: 'Arreglando' },
      { content: 'Correr las pruebas', status: 'pending', activeForm: 'Corriendo' },
      { content: 'Commit', status: 'pending', activeForm: 'Haciendo commit' },
    ],
  } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'clean-bar', surface, ...BAND })
    // Por defecto, una línea: la tarea en curso, posición y porcentaje; sin el plan ni la acción
    expect(await band.find({ type: 'Text', text: /Arreglar el bug/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /2\/4/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /25%/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Leer el código/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /Paso 2 de 4/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /engine AbovePrompt/ })).toBeDefined()

    const row = await $.ui.mount({ plugin: 'clean-bar', surface, ...TOOL_ROW })
    expect(await row.find({ type: 'Text' })).toBeUndefined()
    // Al pulsar la sección, el detalle del plan
    await band.press({ key: 'fold-progress' })
    expect(await band.find({ type: 'Text', text: /Leer el código/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Paso 2 de 4/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /En curso/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Siguiente/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Editar app\.ts/ })).toBeDefined()
    await band.press({ key: 'fold-progress' })
    expect(await band.find({ type: 'Text', text: /Leer el código/ })).toBeUndefined()

    await band.press({ key: 'toggle' })
    expect(await band.find({ type: 'Text', text: /desactivado/ })).toBeDefined()
    await row.redraw()
    expect(await row.find({ type: 'Text' })).toBeDefined()
    await band.press({ key: 'toggle' })
    await band.unmount()
    await row.unmount()
  }

  await $.turn.complete({ answer: 'hecho', durationMs: 4000, isAborted: false, turnId: 't1', reason: 'answer' })
  const band = await $.ui.mount({ plugin: 'clean-bar', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /Listo en 4s/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /189k\/1M/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /19%/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /messages/ })).toBeUndefined()
  // El detalle del progreso trae el resumen completo
  await band.press({ key: 'fold-progress' })
  expect(await band.find({ type: 'Text', text: /Listo en 4s · 1 archivo modificado \(app\.ts\)/ })).toBeDefined()
  // El del contexto (refrescado al terminar el turno) sustituye al anterior: uno a la vez
  await band.press({ key: 'fold-context' })
  expect(await band.find({ type: 'Text', text: /189k de 1M · compacta en 950k/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /messages/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /mcp tools/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /1 archivo modificado/ })).toBeUndefined()
  await band.unmount()
})

test('cuenta atrás de la caché desde la última petición del hilo principal', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.store(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: {}, cost: { usd: 0 } } }) as never)
  on('ui.render', async ($, e) => $.ui.resolve(e).Text({ children: `engine ${e.component}` }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: 'opus', input_tokens: 340, output_tokens: 10, cache_read_input_tokens: 128_000, cache_creation_input_tokens: 2_100 },
    }
  })

  const band = await $.ui.mount({ plugin: 'clean-bar', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /◷ —/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /contexto …/ })).toBeDefined() // la sección de contexto siempre está

  const step = $.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 })
  for await (const _ of step);
  await band.redraw()
  expect(await band.find({ type: 'Text', text: /60:00/ })).toBeDefined()

  await clock.advance(17 * 60_000 + 47_000)
  await band.redraw()
  expect(await band.find({ type: 'Text', text: /42:13/ })).toBeDefined()
  await band.press({ key: 'fold-cache' })
  expect(await band.find({ type: 'Text', text: /Caché caliente/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /caduca en 42m 13s \(TTL 1h\)/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /128k leídos de caché · 2.1k escritos · 340 sin caché/ })).toBeDefined()

  await clock.advance(60 * 60_000)
  await band.redraw()
  expect(await band.find({ type: 'Text', text: /◷ fría/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Caché fría/ })).toBeDefined()
  await band.unmount()
})

test('TTL de 5 minutos por opción', { options: { cacheTtl: '5m' } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  on('ui.render', async ($, e) => $.ui.resolve(e).Text({ children: `engine ${e.component}` }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { model: 'opus', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 }));
  const band = await $.ui.mount({ plugin: 'clean-bar', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /5:00/ })).toBeDefined()
  await band.unmount()
})
