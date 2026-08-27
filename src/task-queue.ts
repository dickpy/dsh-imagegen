/** In-memory, host-resident image generation queue. */

import { randomUUID } from 'node:crypto'
import type { GenerateRequest, GenerateResult, GenerationTask } from './protocol.ts'

export type GenerationTaskListener = (task: GenerationTask) => void

export class GenerationTaskQueue {
  private readonly tasks: GenerationTask[] = []
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<GenerationTaskListener>()
  private running = 0
  private serialRunning = false

  constructor(
    private readonly run: (request: GenerateRequest, signal: AbortSignal) => Promise<GenerateResult>,
    private readonly concurrency = 1,
  ) {}

  list(): GenerationTask[] {
    return this.tasks.map(task => this.snapshot(task))
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
    this.drain()
    return this.snapshot(task)
  }

  retry(id: string): GenerationTask | undefined {
    const previous = this.tasks.find(item => item.id === id)
    return previous === undefined ? undefined : this.submit(previous.request)
  }

  private drain(): void {
    while (this.running < Math.max(1, this.concurrency)) {
      const task = this.tasks.find(item => item.status === 'queued'
        && (this.running === 0 || (item.request.comparisonId !== undefined && !this.serialRunning)))
      if (task === undefined) return
      this.running += 1
      if (task.request.comparisonId === undefined) this.serialRunning = true
      void this.runTask(task).finally(() => {
        this.running -= 1
        if (task.request.comparisonId === undefined) this.serialRunning = false
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
      }
    } catch (error) {
      if (this.tasks.find(item => item.id === task.id)?.status !== 'cancelled') {
        task.status = 'failed'
        task.error = error instanceof Error ? error.message : String(error)
        task.finishedAt = Date.now()
        this.publish(task)
      }
    } finally {
      this.controllers.delete(task.id)
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

  private snapshot(task: GenerationTask): GenerationTask {
    return {
      ...task,
      request: { ...task.request },
      ...task.result === undefined ? {} : { result: task.result },
    }
  }
}
