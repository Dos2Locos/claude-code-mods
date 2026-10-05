export type StepStatus = 'pending' | 'running' | 'done' | 'error'

export type Step = { id: string; label: string; status: StepStatus }

export type Run = {
  isWorking: boolean
  startedAt: number
  durationMs: number
  /** Pasos derivados de las llamadas a herramientas. */
  steps: Step[]
  /** El plan del modelo (TodoWrite / TaskCreate), cuando lo hay. */
  plan: Step[]
  changedFiles: string[]
  commands: number
  errors: number
  isAborted: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': { isOn: boolean; run: Run | null }
  }
}
