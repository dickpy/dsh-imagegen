/**
 * Shared host-side generation runtime. Both the browser routes and Agent tools
 * submit to this one queue so persisted history and cancellation semantics stay
 * identical regardless of where a request originated.
 *
 * Requests carry a channel id (host-filled by the route/tool resolution); the
 * runtime picks that channel's upstream credentials, otherwise the default
 * channel, and records a channel snapshot on the history entry so usage
 * counters and filters survive channel deletion.
 */

import { randomUUID } from 'node:crypto'
import { generateImage, ImageGenError, type UpstreamConfig } from './engine.ts'
import { appendHistory } from './history-store.ts'
import { GenerationTaskQueue } from './task-queue.ts'
import type { ChannelConfig, GenerateRequest, GenerateResult, HistoryEntry, HistoryEntryInput } from './protocol.ts'

/** A channel with its resolved API key (the settings doc holds the key
 *  separately so redacted reads never expose it). */
export interface RuntimeChannel extends ChannelConfig {
  apiKey: string
}

/** The resolved channels view the runtime picks upstream credentials from. */
export interface ChannelsView {
  channels: RuntimeChannel[]
  defaultChannelId: string
}

export interface HistorySink {
  append(entry: HistoryEntryInput): Promise<HistoryEntry[]>
}

export class ImageGenerationRuntime {
  readonly queue: GenerationTaskQueue

  constructor(
    private readonly resolve: () => ChannelsView,
    private readonly history: HistorySink = { append: appendHistory },
  ) {
    // A comparison can contain up to four models; let those tasks run at the
    // same time while still applying a small host-wide concurrency limit.
    this.queue = new GenerationTaskQueue((request, signal) => this.run(request, signal), 4)
  }

  async run(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    const view = this.resolve()
    const channel = view.channels.find(candidate => candidate.id === request.channelId)
      ?? view.channels.find(candidate => candidate.id === view.defaultChannelId)
      ?? view.channels[0]
    if (channel === undefined) {
      throw new ImageGenError('尚未配置任何渠道：请先在「设置 → 插件 → AI 生图」添加渠道并填写 API 地址与密钥', 'no-channels')
    }
    const upstream: UpstreamConfig = { apiUrl: channel.apiUrl, apiKey: channel.apiKey }
    const result = await generateImage(upstream, request, { signal })
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
        ...request.channelId === undefined ? {} : { channelId: request.channelId },
        ...request.channel === undefined ? {} : { channel: request.channel },
        ...request.comparisonId === undefined ? {} : { comparisonId: request.comparisonId },
        ...request.comparisonModels === undefined ? {} : { comparisonModels: request.comparisonModels },
        ...request.workflow === undefined ? {} : { workflow: request.workflow },
        ...request.projectId === undefined ? {} : { projectId: request.projectId },
        ...request.projectName === undefined ? {} : { projectName: request.projectName },
        ...request.slotKey === undefined ? {} : { slotKey: request.slotKey },
        ...request.slotLabel === undefined ? {} : { slotLabel: request.slotLabel },
        ...request.canvas === undefined ? {} : { canvas: request.canvas },
      })
      return { ...result, history }
    } catch (error) {
      return { ...result, historyError: error instanceof Error ? error.message : String(error) }
    }
  }
}
