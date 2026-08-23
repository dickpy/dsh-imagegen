/** In-memory, host-resident image generation queue. */

import { randomUUID } from 'node:crypto'
import type { GenerateRequest, GenerateResult, GenerationTask } from './protocol.ts'

export class GenerationTaskQueue {
  private readonly tasks: GenerationTask[] = []
  private readonly controllers = new Map<string, AbortController>()
  private running = false

  constructor(private readonly run: (request: GenerateRequest, signal: AbortSignal) => Promise<GenerateResult>) {}

  list(): GenerationTask[] {
    return this.tasks.map(task => ({ ...task, request: { ...task.request }, ...(task.result === undefined ? {} : { result: task.result }) }))
  }

  submit(request: GenerateRequest): GenerationTask {
    const task: GenerationTask = { id: randomUUID(), request: { ...request }, status: 'queued', createdAt: Date.now() }
    this.tasks.unshift(task)
    void this.drain()
    return task
  }

  cancel(id: string): GenerationTask | undefined {
    const task = this.tasks.find(item => item.id === id)
    if (task === undefined || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task
    task.status = 'cancelled'
    task.finishedAt = Date.now()
    this.controllers.get(id)?.abort()
    return task
  }

  retry(id: string): GenerationTask | undefined {
    const previous = this.tasks.find(item => item.id === id)
    return previous === undefined ? undefined : this.submit(previous.request)
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const task = this.tasks.find(item => item.status === 'queued')
        if (task === undefined) return
        task.status = 'running'
        task.startedAt = Date.now()
        const controller = new AbortController()
        this.controllers.set(task.id, controller)
        try {
          const result = await this.run(task.request, controller.signal)
          if (this.tasks.find(item => item.id === task.id)?.status !== 'cancelled') {
            task.status = 'completed'
            task.result = result
            task.finishedAt = Date.now()
          }
        } catch (error) {
          if (this.tasks.find(item => item.id === task.id)?.status !== 'cancelled') {
            task.status = 'failed'
            task.error = error instanceof Error ? error.message : String(error)
            task.finishedAt = Date.now()
          }
        } finally {
          this.controllers.delete(task.id)
        }
      }
    } finally {
      this.running = false
    }
  }
}
