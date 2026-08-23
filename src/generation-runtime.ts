/**
 * Shared host-side generation runtime. Both the browser routes and Agent tools
 * submit to this one queue so persisted history and cancellation semantics stay
 * identical regardless of where a request originated.
 */

import { randomUUID } from 'node:crypto'
import { generateImage, type UpstreamConfig } from './engine.ts'
import { appendHistory } from './history-store.ts'
import type { GenerateRequest, GenerateResult, HistoryEntry, HistoryEntryInput } from './protocol.ts'
import { GenerationTaskQueue } from './task-queue.ts'

export interface HistorySink {
  append(entry: HistoryEntryInput): Promise<HistoryEntry[]>
}

export class ImageGenerationRuntime {
  readonly queue: GenerationTaskQueue

  constructor(
    private readonly resolve: () => UpstreamConfig,
    private readonly history: HistorySink = { append: appendHistory },
  ) {
    this.queue = new GenerationTaskQueue((request, signal) => this.run(request, signal))
  }

  async run(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    const result = await generateImage(this.resolve(), request, { signal })
    try {
      const history = await this.history.append({
        id: randomUUID(),
        createdAt: Date.now(),
        mode: request.mode,
        model: request.model,
        prompt: request.prompt,
        size: request.size,
        quality: request.quality,
        detail: request.detail,
        n: request.n,
        images: result.images,
        ...request.refName === undefined ? {} : { refName: request.refName },
      })
      return { ...result, history }
    } catch (error) {
      return { ...result, historyError: error instanceof Error ? error.message : String(error) }
    }
  }
}
