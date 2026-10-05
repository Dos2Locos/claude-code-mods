import { expect, mock, test } from 'claude-code/testing'

import { changeNamedIn, parseTasks, phaseOf } from '../hooks/register'

const ROOT = '/repo'
const CHANGE = '05-update-member-screens-ux'

const TASKS_MD = `## 1. Formulario

- [x] 1.1 Reorganizar UI en bloques
- [ ] 1.2 Grid de parentesco

## 2. QA

- [ ] 2.1 Tests de validación
`

const LIST = {
  changes: [{ name: CHANGE, completedTasks: 1, totalTasks: 3, lastModified: '2026-10-05T10:00:00.000Z', status: 'in-progress' }],
  root: { path: ROOT, source: 'nearest' },
}

const STATUS = {
  changes: [
    {
      changeName: CHANGE,
      applyRequires: ['tasks'],
      artifacts: [
        { id: 'proposal', status: 'done' },
        { id: 'specs', status: 'done' },
        { id: 'design', status: 'ready' },
        { id: 'tasks', status: 'done' },
      ],
    },
  ],
  root: { path: ROOT },
}

const PANE = {
  component: 'Pane',
  requestId: 'openspec',
  props: {
    title: 'OpenSpec',
    isFocused: true,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('detecta el cambio nombrado en rutas, flags y comandos', () => {
  expect(changeNamedIn(`/repo/openspec/changes/${CHANGE}/tasks.md`)).toBe(CHANGE)
  expect(changeNamedIn(`openspec status --change "${CHANGE}" --json`)).toBe(CHANGE)
  expect(changeNamedIn(`/opsx:apply ${CHANGE}`)).toBe(CHANGE)
  expect(changeNamedIn('openspec/changes/archive/2025-01-01-x/tasks.md')).toBeNull()
  expect(changeNamedIn('openspec list --json')).toBeNull()
})

test('calcula la fase del flujo', () => {
  const art = (status: string) => [
    { id: 'proposal', status: 'done' },
    { id: 'specs', status },
    { id: 'tasks', status },
  ]
  expect(phaseOf(art('ready'), ['tasks'], 0, 0)).toBe('specs')
  expect(phaseOf(art('done'), ['tasks'], 2, 5)).toBe('apply')
  expect(phaseOf(art('done'), ['tasks'], 5, 5)).toBe('archive')
})

test('agrupa las tareas por sección', () => {
  const sections = parseTasks(TASKS_MD)
  expect(sections.map(s => s.title)).toEqual(['1. Formulario', '2. QA'])
  expect(sections[0]?.tasks).toEqual([
    { text: '1.1 Reorganizar UI en bloques', isDone: true },
    { text: '1.2 Grid de parentesco', isDone: false },
  ])
})

test('el panel lista los cambios, abre el detalle y prepara /opsx:apply', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-05T12:00:00.000Z') })
  mock.env(on, { HOME: '/home/me' })
  const filled: string[] = []
  let statusLine: string | undefined

  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: ROOT }))
  on('process.run', async (_$, e) => {
    const args = e.argv.slice(1).join(' ')
    const out = args.startsWith('list') ? LIST : args.startsWith('status') ? STATUS : { items: [{ valid: true, issues: [] }] }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', async (_$, e) => ({ value: e.path.endsWith('tasks.md') || e.path === '/home/me/.claude/commands/opsx' }))
  on('fs.read', async () => ({ value: TASKS_MD }))
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.status', async (_$, e) => {
    statusLine = (e as { text?: string }).text
    return { value: undefined }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('command.register', async () => ({ value: {} }) as never)
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'openspec', args: '' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'openspec-tracker', surface, ...PANE })
    expect(await pane.find({ type: 'Text', text: /1 cambio activo/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /implementación/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /1\/3/ })).toBeDefined()

    await pane.press({ key: `open-${CHANGE}` })
    expect(await pane.find({ type: 'Text', text: /1\.2 Grid de parentesco/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /2\. QA/ })).toBeDefined()

    await pane.press({ key: 'apply' })
    expect(filled.at(-1)).toBe(`/opsx:apply ${CHANGE}`)
    expect(statusLine).toBe(`◐ OpenSpec ${CHANGE} · 1/3 · implementación`)

    await pane.press({ key: 'validate' })
    expect(await pane.find({ type: 'Text', text: /Validación correcta/ })).toBeDefined()

    await pane.press({ key: 'back' })
    await pane.unmount()
  }
})
