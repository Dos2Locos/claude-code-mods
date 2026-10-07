import { expect, mock, test } from 'claude-code/testing'

import { applyWorkState, bar, currentTask, progress } from '../hooks/register'

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

test('muestra solo la tarea en curso, la barra y el porcentaje; oculta las herramientas', async ($, on) => {
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
    expect(await band.find({ type: 'Text', text: /Arreglar el bug/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Leer el código/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /25%/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /tarea 2 de 4/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Editar app\.ts/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /engine AbovePrompt/ })).toBeDefined()

    const row = await $.ui.mount({ plugin: 'clean-bar', surface, ...TOOL_ROW })
    expect(await row.find({ type: 'Text' })).toBeUndefined()
    // Plegada, la sección de progreso cabe en una línea: la tarea y el porcentaje, sin la acción
    await band.press({ key: 'fold-progress' })
    expect(await band.find({ type: 'Text', text: /Arreglar el bug/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /2\/4/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Editar app\.ts/ })).toBeUndefined()
    await band.press({ key: 'fold-progress' })

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
  expect(await band.find({ type: 'Text', text: /Listo en 4s · 1 archivo modificado \(app\.ts\)/ })).toBeDefined()
  // La sección de contexto, refrescada al terminar el turno
  expect(await band.find({ type: 'Text', text: /189k de 1M · compacta en 950k/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /19%/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /messages/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /mcp tools/ })).toBeUndefined()
  // Plegada, el contexto pierde la leyenda y conserva uso y porcentaje
  await band.press({ key: 'fold-context' })
  expect(await band.find({ type: 'Text', text: /messages/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /189k de 1M/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /compacta en/ })).toBeUndefined()
  await band.unmount()
})
