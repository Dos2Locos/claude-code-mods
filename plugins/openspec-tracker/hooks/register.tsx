import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Artifact, ChangeInfo, Detail, Snapshot, TaskSection, Validation, View } from '../types'

const snapshot = atom({ plugin: 'openspec-tracker', key: 'snapshot' } as const, null)
const current = atom({ plugin: 'openspec-tracker', key: 'current' } as const, null)
const view = atom({ plugin: 'openspec-tracker', key: 'view' } as const, { kind: 'list' } as View)
const detail = atom({ plugin: 'openspec-tracker', key: 'detail' } as const, null)

const PANE = 'openspec'
const REFRESH_DELAY_MS = 400
/** Dónde buscar la CLI cuando no está en el PATH del proceso. */
const OPENSPEC_BINS = ['openspec', '/opt/homebrew/bin/openspec', '/usr/local/bin/openspec']

const PHASE_LABEL: Record<string, string> = {
  proposal: 'propuesta',
  specs: 'specs',
  design: 'diseño',
  tasks: 'tareas',
  apply: 'implementación',
  archive: 'listo para archivar',
}

const ARTIFACT_ICON: Record<string, string> = { done: '✓', ready: '○', blocked: '·' }

// Temporizador del refresco agrupado; se pierde en una recarga, y no importa.
let pendingRefresh: Timer | null = null

// ── Lectura del estado ──────────────────────────────────────────────────────

type ListJson = {
  changes?: { name: string; completedTasks: number; totalTasks: number; lastModified: string }[]
  root?: { path: string } | null
}

type StatusJson = {
  changes?: { changeName: string; applyRequires?: string[]; artifacts?: Artifact[] }[]
}

async function runOpenspec($: EngineInterface, args: string[]): Promise<{ ok: boolean; json: unknown; text: string }> {
  for (const bin of OPENSPEC_BINS) {
    try {
      const ran = await $.process.run([bin, ...args], { timeoutMs: 20_000 })
      try {
        return { ok: ran.exitCode === 0, json: JSON.parse(ran.stdout), text: ran.stdout }
      } catch {
        return { ok: false, json: null, text: ran.stderr || ran.stdout }
      }
    } catch {
      // No se pudo arrancar con esta ruta: probamos la siguiente.
    }
  }
  return { ok: false, json: null, text: 'No encuentro la CLI `openspec` (npm i -g @fission-ai/openspec).' }
}

/** La fase: el primer artefacto pendiente, o implementación / archivar cuando ya se puede aplicar. */
export function phaseOf(artifacts: Artifact[], applyRequires: string[], completed: number, total: number): string {
  const isDone = (id: string) => artifacts.find(a => a.id === id)?.status === 'done'
  if (applyRequires.length > 0 && applyRequires.every(isDone)) {
    return total > 0 && completed === total ? 'archive' : 'apply'
  }
  return artifacts.find(a => a.status !== 'done')?.id ?? 'apply'
}

async function loadSnapshot($: EngineInterface): Promise<Snapshot> {
  const now = await $.clock.now()
  const cwd = await $.session.cwd()
  const list = await runOpenspec($, ['list', '--json'])
  const listJson = list.json as ListJson | null
  if (!listJson || !listJson.root) {
    const error = listJson ? 'Este proyecto no usa OpenSpec (no hay carpeta openspec/).' : list.text.trim()
    return { root: cwd, changes: [], error, refreshedAt: now }
  }

  const status = await runOpenspec($, ['status', '--all', '--json'])
  const byName = new Map(((status.json as StatusJson | null)?.changes ?? []).map(c => [c.changeName, c]))

  const changes: ChangeInfo[] = (listJson.changes ?? []).map(c => {
    const s = byName.get(c.name)
    const artifacts = (s?.artifacts ?? []).map(a => ({ id: a.id, status: a.status }))
    return {
      name: c.name,
      completed: c.completedTasks,
      total: c.totalTasks,
      lastModified: c.lastModified,
      artifacts,
      phase: phaseOf(artifacts, s?.applyRequires ?? [], c.completedTasks, c.totalTasks),
    }
  })
  return { root: listJson.root.path, changes, error: null, refreshedAt: now }
}

/** Las tareas de `tasks.md` agrupadas por sus encabezados `##`. */
export function parseTasks(markdown: string): TaskSection[] {
  const sections: TaskSection[] = []
  let section: TaskSection | null = null
  for (const line of markdown.split('\n')) {
    const heading = /^#{2,4}\s+(.+?)\s*$/.exec(line)
    if (heading?.[1]) {
      section = { title: heading[1], tasks: [] }
      sections.push(section)
      continue
    }
    const task = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line)
    if (task?.[2]) {
      if (!section) {
        section = { title: 'Tareas', tasks: [] }
        sections.push(section)
      }
      section.tasks.push({ text: task[2], isDone: task[1] !== ' ' })
    }
  }
  return sections.filter(s => s.tasks.length > 0)
}

async function loadSections($: EngineInterface, root: string, name: string): Promise<TaskSection[]> {
  const path = `${root}/openspec/changes/${name}/tasks.md`
  if (!(await $.fs.exists(path))) return []
  return parseTasks(String(await $.fs.read(path)))
}

async function refresh($: EngineInterface) {
  const before = await read($, snapshot)
  const next = await loadSnapshot($)
  await update($, snapshot, () => next)

  // Aviso cuando un cambio acaba de completar todas sus tareas.
  for (const change of next.changes) {
    const old = before?.changes.find(c => c.name === change.name)
    if (old && old.phase !== 'archive' && change.phase === 'archive') {
      $.ui.toast(`OpenSpec: «${change.name}» completó sus tareas, listo para archivar`)
    }
  }

  const selected = await read($, view)
  if (selected.kind === 'detail') {
    const sections = await loadSections($, next.root, selected.name)
    await update($, detail, d =>
      d && d.name === selected.name ? { ...d, sections } : { name: selected.name, sections, validation: null, isValidating: false },
    )
  }
  await showStatusLine($)
}

function scheduleRefresh($: EngineInterface) {
  pendingRefresh?.cancel()
  pendingRefresh = $.clock.after(REFRESH_DELAY_MS, () => {
    pendingRefresh = null
    void refresh($).catch(() => undefined)
  })
}

// ── Cambio en curso y línea de estado ───────────────────────────────────────

/** El cambio al que se refiere una ruta, un comando o un prompt, si nombra uno. */
export function changeNamedIn(text: string): string | null {
  const path = /openspec\/changes\/(?!archive\/)([^/\s"']+)\//.exec(text)
  if (path?.[1]) return path[1]
  const flag = /--change[= ]["']?([\w.-]+)/.exec(text)
  if (flag?.[1]) return flag[1]
  const command = /(?:\/opsx:\w+|openspec\s+(?:archive|validate|show))\s+["']?([\w.-]+)/.exec(text)
  return command?.[1] && !command[1].startsWith('-') ? command[1] : null
}

async function setCurrent($: EngineInterface, name: string | null) {
  if (!name || (await read($, current)) === name) return
  await update($, current, () => name)
  await showStatusLine($)
}

function progressBar(done: number, total: number, width: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

async function showStatusLine($: EngineInterface) {
  const snap = await read($, snapshot)
  if (!snap || snap.error) return $.ui.status(undefined)
  const name = await read($, current)
  const change = snap.changes.find(c => c.name === name)
  if (change) {
    const tasks = change.total > 0 ? ` · ${change.completed}/${change.total}` : ''
    $.ui.status(`◐ OpenSpec ${change.name}${tasks} · ${PHASE_LABEL[change.phase] ?? change.phase}`)
  } else {
    const n = snap.changes.length
    $.ui.status(n === 0 ? undefined : `OpenSpec · ${n} ${n === 1 ? 'cambio activo' : 'cambios activos'} · /openspec`)
  }
}

// ── Acciones ────────────────────────────────────────────────────────────────

async function hasOpsx($: EngineInterface, root: string): Promise<boolean> {
  const home = await $.env.get('HOME')
  const places = [`${root}/.claude/commands/opsx`, ...(home ? [`${home}/.claude/commands/opsx`] : [])]
  for (const place of places) if (await $.fs.exists(place)) return true
  return false
}

/** Escribe el comando en el prompt sin enviarlo: tú decides si lo lanzas. */
async function prepare($: EngineInterface, action: 'apply' | 'archive' | 'explore', name: string) {
  const snap = await read($, snapshot)
  const opsx = await hasOpsx($, snap?.root ?? (await $.session.cwd()))
  const fallback = {
    apply: `Implementa las tareas del cambio de OpenSpec «${name}».`,
    archive: `Archiva el cambio de OpenSpec «${name}» y actualiza las specs.`,
    explore: `Revisa el cambio de OpenSpec «${name}» y dime qué falta.`,
  }
  const text = opsx ? `/opsx:${action} ${name}` : fallback[action]
  const filled = await $.prompt.fill({ text })
  if (!filled.isFilled) $.ui.toast(`Escribe: ${text}`)
  await setCurrent($, name)
}

async function validate($: EngineInterface, name: string) {
  await update($, detail, d => (d && d.name === name ? { ...d, isValidating: true } : d))
  const ran = await runOpenspec($, ['validate', name, '--json'])
  const item = (ran.json as { items?: { valid: boolean; issues?: unknown[] }[] } | null)?.items?.[0]
  const validation: Validation = item
    ? { isValid: item.valid, issues: (item.issues ?? []).map(issueText) }
    : { isValid: false, issues: [ran.text.trim() || 'No se pudo validar.'] }
  await update($, detail, d => (d && d.name === name ? { ...d, validation, isValidating: false } : d))
}

function issueText(issue: unknown): string {
  if (typeof issue === 'string') return issue
  const i = issue as { message?: string; path?: string; level?: string }
  return [i.level, i.path, i.message].filter(Boolean).join(' · ') || JSON.stringify(issue)
}

async function openDetail($: EngineInterface, name: string) {
  const snap = await read($, snapshot)
  await update($, view, () => ({ kind: 'detail', name }) as View)
  const sections = snap ? await loadSections($, snap.root, name) : []
  await update($, detail, () => ({ name, sections, validation: null, isValidating: false }) as Detail)
}

async function backToList($: EngineInterface) {
  await update($, view, () => ({ kind: 'list' }) as View)
}

function relativeTime(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (Number.isNaN(minutes)) return ''
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `hace ${hours} h`
  return `hace ${Math.round(hours / 24)} d`
}

// ── Registro ────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'openspec',
      description: 'Abre el panel de OpenSpec Tracker con los cambios activos del proyecto',
      immediate: true,
    })
    // Sin esperar: la sesión arranca ya y el estado llega en cuanto la CLI responde.
    void refresh($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'openspec' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'OpenSpec', focus: true })
    return {}
  })

  // Detecta el cambio en curso por el prompt (/opsx:apply <id>, …).
  on('prompt.submit', async ($, e, next) => {
    if (/\/opsx:|openspec/i.test(e.text)) await setCurrent($, changeNamedIn(e.text))
    return next(e)
  })

  // Detecta el cambio en curso y refresca cuando se toca OpenSpec.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const fields = e as unknown as Record<string, unknown>
    const text = [fields.file_path, fields.command, fields.skill, fields.args]
      .filter(v => typeof v === 'string')
      .join(' ')
    const touchesOpenspec = /openspec/i.test(text)
    if (touchesOpenspec) await setCurrent($, changeNamedIn(text))

    const ran = await next(e)
    const writes = ['Edit', 'MultiEdit', 'Write', 'Bash', 'Skill'].includes(tool)
    if (touchesOpenspec && writes) scheduleRefresh($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) scheduleRefresh($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const selected = await read($, view)
    const width = Math.max(8, Math.min(20, e.props.bodyColumns - 30))

    const refreshButton = (
      <Button key="refresh" hotkey="r" plain label="Actualizar" onPress={() => refresh($)} />
    )

    if (!snap) return <Text dimColor>Leyendo OpenSpec…</Text>
    if (snap.error) {
      return (
        <Box flexDirection="column">
          <Text color="yellow">{snap.error}</Text>
          {refreshButton}
        </Box>
      )
    }

    if (selected.kind === 'detail') {
      const change = snap.changes.find(c => c.name === selected.name)
      const d = await read($, detail)
      const back = <Button key="back" hotkey="b" plain label="Volver" onPress={() => backToList($)} />
      if (!change) {
        return (
          <Box flexDirection="column">
            <Text dimColor>«{selected.name}» ya no está activo (¿archivado?).</Text>
            {back}
          </Box>
        )
      }
      const sections = d?.name === change.name ? d.sections : []
      return (
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">{change.name}</Text>
          <Text>
            <Text dimColor>Fase: </Text>
            <Text color="cyan">{PHASE_LABEL[change.phase] ?? change.phase}</Text>
          </Text>
          <Text wrap="wrap">
            {change.artifacts.map(a => (
              <Text color={a.status === 'done' ? 'green' : undefined} dimColor={a.status === 'blocked'}>
                {ARTIFACT_ICON[a.status] ?? '○'} {a.id}{'  '}
              </Text>
            ))}
          </Text>
          {change.total > 0 && (
            <Text>
              <Text color={change.completed === change.total ? 'green' : 'yellow'}>
                {progressBar(change.completed, change.total, width)}
              </Text>
              <Text dimColor> {change.completed}/{change.total} tareas</Text>
            </Text>
          )}
          <Box columnGap={2} flexWrap="wrap">
            <Button key="apply" hotkey="a" plain label="Aplicar" onPress={() => prepare($, 'apply', change.name)} />
            <Button key="validate" hotkey="v" plain label="Validar" onPress={() => validate($, change.name)} />
            <Button key="archive" hotkey="x" plain label="Archivar" onPress={() => prepare($, 'archive', change.name)} />
            <Button key="explore" hotkey="e" plain label="Revisar" onPress={() => prepare($, 'explore', change.name)} />
            {back}
          </Box>
          {d?.isValidating && <Text dimColor>Validando…</Text>}
          {d?.validation && (
            <Box flexDirection="column">
              <Text color={d.validation.isValid ? 'green' : 'red'}>
                {d.validation.isValid ? '✓ Validación correcta' : `✗ ${d.validation.issues.length} problemas`}
              </Text>
              {d.validation.issues.slice(0, 5).map(issue => (
                <Text dimColor wrap="truncate-end">  {issue}</Text>
              ))}
            </Box>
          )}
          {sections.map(section => {
            const done = section.tasks.filter(t => t.isDone).length
            return (
              <Box flexDirection="column" marginTop={1}>
                <Text bold wrap="truncate-end">
                  {section.title} <Text dimColor>{done}/{section.tasks.length}</Text>
                </Text>
                {section.tasks.map(task => (
                  <Text wrap="truncate-end" dimColor={task.isDone}>
                    <Text color={task.isDone ? 'green' : undefined}>{task.isDone ? ' ✓ ' : ' ○ '}</Text>
                    {task.text}
                  </Text>
                ))}
              </Box>
            )
          })}
        </Box>
      )
    }

    const active = await read($, current)
    const now = await $.clock.now()
    return (
      <Box flexDirection="column">
        <Box columnGap={2}>
          <Text bold>
            {snap.changes.length} {snap.changes.length === 1 ? 'cambio activo' : 'cambios activos'}
          </Text>
          {refreshButton}
        </Box>
        {snap.changes.length === 0 && <Text dimColor>Nada en curso. Crea uno con /opsx:propose.</Text>}
        {snap.changes.map((change, i) => (
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Button
                key={`open-${change.name}`}
                plain
                {...(i < 9 ? { hotkey: String(i + 1) } : {})}
                label={`${change.name === active ? '◐ ' : ''}${change.name}`}
                onPress={() => openDetail($, change.name)}
              />
            </Box>
            <Text>
              {'   '}
              <Text color="cyan">{PHASE_LABEL[change.phase] ?? change.phase}</Text>
              {change.total > 0 && (
                <Text>
                  {'  '}
                  <Text color={change.completed === change.total ? 'green' : 'yellow'}>
                    {progressBar(change.completed, change.total, width)}
                  </Text>
                  <Text dimColor> {change.completed}/{change.total}</Text>
                </Text>
              )}
              <Text dimColor>  {relativeTime(change.lastModified, now)}</Text>
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
