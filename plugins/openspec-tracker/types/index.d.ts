export type ArtifactStatus = 'done' | 'ready' | 'blocked' | string

export type Artifact = { id: string; status: ArtifactStatus }

/** Fase del flujo: el primer artefacto pendiente, `apply` o `archive`. */
export type Phase = string

export type ChangeInfo = {
  name: string
  completed: number
  total: number
  lastModified: string
  artifacts: Artifact[]
  phase: Phase
}

export type Snapshot = {
  root: string
  changes: ChangeInfo[]
  /** Por qué no se pudo leer el estado (sin CLI, sin carpeta openspec/). */
  error: string | null
  refreshedAt: number
}

export type TaskItem = { text: string; isDone: boolean }

export type TaskSection = { title: string; tasks: TaskItem[] }

export type Validation = { isValid: boolean; issues: string[] }

export type Detail = {
  name: string
  sections: TaskSection[]
  validation: Validation | null
  isValidating: boolean
}

export type View = { kind: 'list' } | { kind: 'detail'; name: string }

declare module 'claude-code' {
  interface PluginState {
    'openspec-tracker': {
      snapshot: Snapshot | null
      current: string | null
      view: View
      detail: Detail | null
    }
  }
}
