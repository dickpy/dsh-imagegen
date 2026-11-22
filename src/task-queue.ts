/** In-memory, host-resident image generation queue. */

import { randomUUID } from 'node:crypto'
import type { GenerateRequest, GenerateResult, GenerationTask, GenerationTaskSummary } from './protocol.ts'

export type GenerationTaskListener = (task: GenerationTask) => void

/** Terminal tasks kept in memory with their full results. Older terminal
 *  tasks are dropped from the queue entirely: their images live in the
 *  history store on disk, the poll feed only ever surfaced the newest rows,
 *  and an unbounded array kept every base64 result resident until restart. */
export const RETAINED_TERMINAL_TASKS = 50

export class GenerationTaskQueue {
  private readonly tasks: GenerationTask[] = []
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<GenerationTaskListener>()
  private running = 0
  // Plain fields assigned in the constructor body: parameter properties are
  // not expressible under Node's strip-only TS mode, which the unit tests use.
  private readonly run: (request: GenerateRequest, signal: AbortSignal) => Promise<GenerateResult>
  private readonly concurrency: number

  constructor(
    run: (request: GenerateRequest, signal: AbortSignal) => Promise<GenerateResult>,
    concurrency = 1,
  ) {
    this.run = run
    this.concurrency = concurrency
  }

  list(): GenerationTask[] {
    return this.tasks.map(task => this.snapshot(task))
  }

  /**
   * Bounded poll payload: active tasks plus the newest terminal summaries.
   * Image data and completed results are intentionally omitted.
   */
  summaries(terminalLimit = 100): GenerationTaskSummary[] {
    const limit = Math.max(0, Math.floor(terminalLimit))
    const active = this.tasks.filter(task => task.status === 'queued' || task.status === 'running')
    const terminal = this.tasks.filter(task => task.status !== 'queued' && task.status !== 'running').slice(0, limit)
    const selected = new Set([...active, ...terminal].map(task => task.id))
    return this.tasks.filter(task => selected.has(task.id)).map(task => this.summary(task))
  }

  get(id: string): GenerationTask | undefined {
    const task = this.tasks.find(item => item.id === id)
    return task === undefined ? undefined : this.snapshot(task)
  }

  /** Observe queue state changes. Listener failures never disrupt generation. */
  subscribe(listener: GenerationTaskListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  submit(request: GenerateRequest): GenerationTask {
    const task: GenerationTask = { id: randomUUID(), request: { ...request }, status: 'queued', createdAt: Date.now() }
    this.tasks.unshift(task)
    this.publish(task)
    this.drain()
    return this.snapshot(task)
  }

  cancel(id: string): GenerationTask | undefined {
    const task = this.tasks.find(item => item.id === id)
    if (task === undefined || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task
    task.status = 'cancelled'
    task.finishedAt = Date.now()
    this.controllers.get(id)?.abort()
    this.publish(task)
    this.pruneTerminal()
    this.drain()
    return this.snapshot(task)
  }

  retry(id: string): GenerationTask | undefined {
    const previous = this.tasks.find(item => item.id === id)
    return previous === undefined ? undefined : this.submit(previous.request)
  }

  /** Start queued tasks while capacity remains. Plain submissions and
   * comparison batches alike run in parallel up to the host-wide limit, so one
   * slow upstream can no longer hold back unrelated generations. */
  private drain(): void {
    while (this.running < Math.max(1, this.concurrency)) {
      const task = this.tasks.find(item => item.status === 'queued')
      if (task === undefined) return
      this.running += 1
      void this.runTask(task).finally(() => {
        this.running -= 1
        this.drain()
      })
    }
  }

  private async runTask(task: GenerationTask): Promise<void> {
    task.status = 'running'
    task.startedAt = Date.now()
    this.publish(task)
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    try {
      const result = await this.run(task.request, controller.signal)
      if (this.tasks.find(item => item.id === task.id)?.status !== 'cancelled') {
        task.status = 'completed'
        task.result = result
        task.finishedAt = Date.now()
        this.publish(task)
        this.pruneTerminal()
      }
    } catch (error) {
      if (this.tasks.find(item => item.id === task.id)?.status !== 'cancelled') {
        task.status = 'failed'
        task.error = error instanceof Error ? error.message : String(error)
        task.finishedAt = Date.now()
        this.publish(task)
        this.pruneTerminal()
      }
    } finally {
      this.controllers.delete(task.id)
    }
  }

  /**
   * Drop terminal tasks beyond the retention window, keeping the most
   * recently finished ones. Active tasks are never touched; a dropped id
   * simply stops appearing in summaries and answers `undefined` from `get`,
   * which the panel already treats the same way as a task pushed out of the
   * bounded poll feed.
   */
  private pruneTerminal(): void {
    const terminal: number[] = []
    for (let index = 0; index < this.tasks.length; index++) {
      const task = this.tasks[index]!
      if (task.status !== 'queued' && task.status !== 'running') terminal.push(index)
    }
    if (terminal.length <= RETAINED_TERMINAL_TASKS) return
    // Oldest finished first. The tasks array is newest-submission-first, so
    // the reversed index run breaks full timestamp ties toward dropping the
    // oldest submissions (never the task that just finished on screen).
    const finishedAtOf = (index: number): number => {
      const task = this.tasks[index]!
      return task.finishedAt ?? task.createdAt
    }
    const ordered = terminal.reverse().sort((a, b) =>
      (finishedAtOf(a) - finishedAtOf(b)) || (this.tasks[a]!.createdAt - this.tasks[b]!.createdAt))
    const drop = new Set(ordered.slice(0, ordered.length - RETAINED_TERMINAL_TASKS))
    for (let index = this.tasks.length - 1; index >= 0; index--) {
      if (drop.has(index)) this.tasks.splice(index, 1)
    }
  }

  private publish(task: GenerationTask): void {
    const snapshot = this.snapshot(task)
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Observers must not be able to interrupt the queue pump.
      }
    }
  }

  private summary(task: GenerationTask): GenerationTaskSummary {
    const request = { ...task.request }
    delete request.image
    delete request.images
    delete request.mask
    return {
      id: task.id,
      request,
      status: task.status,
      createdAt: task.createdAt,
      ...task.startedAt === undefined ? {} : { startedAt: task.startedAt },
      ...task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt },
      ...task.error === undefined ? {} : { error: task.error },
      resultAvailable: task.result !== undefined,
    }
  }

  private snapshot(task: GenerationTask): GenerationTask {
    return {
      ...task,
      request: { ...task.request },
      ...task.result === undefined ? {} : { result: task.result },
    }
  }
}
