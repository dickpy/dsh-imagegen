import type { GenerateMode, GenerateRequest, GenerationTask, GenerationTaskStatus } from '../protocol.ts'

/** Small, per-tab workspace records. Never persist image bytes or credentials. */
export interface StudioSlot {
  id: string
  taskId: string
  imageIndex: number
  model: string
  channelId: string
  status?: GenerationTaskStatus
  error?: string
  previous?: { taskId: string; imageIndex: number }
}
export interface StudioRun {
  id: string
  mode: GenerateMode
  prompt: string
  sourceTaskId: string
  slots: StudioSlot[]
}
export type StudioRuns = Record<GenerateMode, StudioRun | null>
export const STUDIO_STORAGE_KEY = 'dsh-imagegen:studio-runs:v1'

export function newStudioRun(id: string, mode: GenerateMode, prompt: string, tasks: GenerationTask[]): StudioRun {
  return { id, mode, prompt, sourceTaskId: tasks[0]!.id, slots: tasks.flatMap(task => slotsForTask(task)) }
}
export function slotsForTask(task: GenerationTask): StudioSlot[] {
  return Array.from({ length: Math.max(1, Math.min(4, task.request.n)) }, (_, imageIndex) => ({
    id: `${task.id}:${imageIndex}`, taskId: task.id, imageIndex,
    model: task.request.model, channelId: task.request.channelId ?? '', status: task.status,
  }))
}
export function studioTaskIds(runs: StudioRuns): Set<string> {
  return new Set(Object.values(runs).flatMap(run => run === null ? [] : [run.sourceTaskId, ...run.slots.flatMap(slot => [slot.taskId, ...(slot.previous === undefined ? [] : [slot.previous.taskId])])]))
}
export function replaceStudioSlot(run: StudioRun, slotId: string, task: GenerationTask): StudioRun {
  return { ...run, slots: run.slots.map(slot => slot.id !== slotId ? slot : {
    ...slot, previous: slot.status === 'completed' ? { taskId: slot.taskId, imageIndex: slot.imageIndex } : slot.previous,
    taskId: task.id, imageIndex: 0, status: task.status, error: undefined,
  }) }
}
/** Catalog order is also the board order, regardless of checkbox click order. */
export function orderedStudioChoices<T extends { id: string; models: string[] }>(groups: T[], keys: string[], keyOf: (channel: string, model: string) => string): { channelId: string; model: string }[] {
  const selected = new Set(keys)
  return groups.flatMap(group => group.models.filter(model => selected.has(keyOf(group.id, model))).map(model => ({ channelId: group.id, model })))
}
export function readStudioRuns(storage?: Pick<Storage, 'getItem'> | null): StudioRuns {
  const empty: StudioRuns = { text: null, edit: null }
  try {
    const raw = JSON.parse(storage?.getItem(STUDIO_STORAGE_KEY) ?? 'null')
    for (const mode of ['text', 'edit'] as const) {
      const run = raw?.[mode]
      if (run === null || typeof run !== 'object' || run.mode !== mode || typeof run.id !== 'string' || typeof run.prompt !== 'string' || typeof run.sourceTaskId !== 'string' || !Array.isArray(run.slots)) continue
      const slots: StudioSlot[] = run.slots.slice(0, 80).filter((slot: StudioSlot) => slot && typeof slot.id === 'string' && typeof slot.taskId === 'string' && typeof slot.model === 'string' && typeof slot.channelId === 'string' && Number.isInteger(slot.imageIndex) && slot.imageIndex >= 0 && slot.imageIndex < 4).map((slot: StudioSlot) => ({
        id: slot.id, taskId: slot.taskId, imageIndex: slot.imageIndex, model: slot.model, channelId: slot.channelId,
        ...['queued', 'running', 'completed', 'failed', 'cancelled'].includes(slot.status ?? '') ? { status: slot.status } : {},
        ...typeof slot.error === 'string' ? { error: slot.error } : {},
        ...slot.previous && typeof slot.previous.taskId === 'string' && Number.isInteger(slot.previous.imageIndex) && slot.previous.imageIndex >= 0 && slot.previous.imageIndex < 4 ? { previous: { taskId: slot.previous.taskId, imageIndex: slot.previous.imageIndex } } : {},
      }))
      empty[mode] = { id: run.id, mode, prompt: run.prompt, sourceTaskId: run.sourceTaskId, slots }
    }
  } catch { /* unavailable or corrupt storage must not block generation */ }
  return empty
}
export function writeStudioRuns(storage: Pick<Storage, 'setItem'> | null | undefined, runs: StudioRuns): void {
  try { storage?.setItem(STUDIO_STORAGE_KEY, JSON.stringify(runs)) } catch { /* optional persistence */ }
}
/** Preserve all original references and mask; regenerate only the requested card. */
export function studioRetryRequest(request: GenerateRequest): GenerateRequest {
  return { ...request, n: 1 }
}
