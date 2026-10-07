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

declare module 'claude-code' {
  interface PluginState {
    'clean-bar': { isOn: boolean; run: Run | null }
  }
}
