export type StepStatus = 'pending' | 'running' | 'done' | 'error'

export type Step = { id: string; label: string; status: StepStatus }

export type Run = {
  isWorking: boolean
  /** El prompt que abrió el turno, para la cabecera. */
  title: string
  startedAt: number
  durationMs: number
  /** El plan del modelo (TodoWrite / TaskCreate), cuando lo hay. */
  plan: Step[]
  /** La última llamada a herramienta, en una frase. */
  activity?: Step
  toolCalls: number
  changedFiles: string[]
  commands: number
  errors: number
  isAborted: boolean
}

export type Slice = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }

/** Lectura de la ventana de contexto, como la desglosa /context. */
export type Reading = {
  slices: Slice[]
  total: number
  window: number
  percent: number
  compactsAt?: number
}

/** Qué secciones se muestran en una sola línea. */
export type Compact = { progress: boolean; context: boolean }

declare module 'claude-code' {
  interface PluginState {
    'clean-bar': { isOn: boolean; compact: Compact; run: Run | null; reading: Reading | null }
  }
}
