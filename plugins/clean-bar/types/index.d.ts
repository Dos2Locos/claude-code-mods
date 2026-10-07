export type StepStatus = 'pending' | 'running' | 'done' | 'error'

export type Step = { id: string; label: string; status: StepStatus }

export type Run = {
  isWorking: boolean
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

declare module 'claude-code' {
  interface PluginState {
    'clean-bar': { isOn: boolean; run: Run | null; reading: Reading | null }
  }
}
