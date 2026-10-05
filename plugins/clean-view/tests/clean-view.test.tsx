import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const TOOL_ROW = {
  component: 'ToolUse',
  props: {
    tool_use_id: 'tu1',
    tool: 'Bash',
    input: { command: 'ls' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  },
} as const

test('muestra pasos, progreso y resumen, y oculta las filas de herramientas', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: {} as never }))
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const suffix = (e.props as { suffix?: string }).suffix ?? ''
    return <Text>{`engine ${e.component}${suffix}`}</Text>
  })

  await $.turn.start({ text: 'arregla el bug', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Correr las pruebas' } as never)

  const spinner = await $.ui.mount({
    plugin: 'clean-view',
    surface: 'terminal',
    component: 'Spinner',
    props: { word: 'Pensando', message: null, suffix: '…', mode: 'tool-use' },
  })
  expect(await spinner.find({ type: 'Text', text: /engine Spinner · paso 2\/2…/ })).toBeDefined()
  await spinner.unmount()

  const finished = await $.turn.complete({
    answer: 'hecho',
    durationMs: 4000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  expect(finished.text).toBe('Clean View · Listo en 4s · 1 archivo modificado (app.ts) · 1 comando')

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'clean-view', surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /Editar app\.ts/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Ejecutar: Correr las pruebas/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /2\/2/ })).toBeDefined()
    // Lo que dibujan otros mods en la banda sigue apareciendo
    expect(await band.find({ type: 'Text', text: /engine AbovePrompt/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Listo en 4s · 1 archivo modificado \(app\.ts\) · 1 comando/ })).toBeDefined()

    const row = await $.ui.mount({ plugin: 'clean-view', surface, ...TOOL_ROW })
    expect(await row.find({ type: 'Text' })).toBeUndefined()

    await band.press({ key: 'toggle' })
    expect(await band.find({ type: 'Text', text: /desactivado/ })).toBeDefined()
    await row.redraw()
    expect(await row.find({ type: 'Text' })).toBeDefined()

    await band.press({ key: 'toggle' })
    await band.unmount()
    await row.unmount()
  }
})
