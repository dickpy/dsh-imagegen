/** Agent-facing image-generation tools backed by the shared host queue. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-tools'
import { ImageGenError } from './engine.ts'
import { ImageGenerationRuntime } from './generation-runtime.ts'
import { normalizeImageModels } from './image-models.ts'
import type { GenerationTask, GeneratedImage } from './protocol.ts'

export interface AgentImageToolConfig {
  enabled: boolean
  allowAgentImageGeneration: boolean
  apiUrl: string
  apiKey: string
  imageModels: string[]
}

interface AgentImageRef {
  attachment_id: string
  media_type: string
  bytes: number
  width: number
  height: number
  name?: string
}

interface AgentTaskResult {
  task_id: string
  status: string
  message: string
  error?: string
  images: AgentImageRef[]
}

const imageRefSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachment_id: { type: 'string', required: true },
    media_type: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
} as const

const taskResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task_id: { type: 'string', required: true },
    status: { type: 'string', required: true },
    message: { type: 'string', required: true },
    error: { type: 'string' },
    images: { type: 'array', required: true, items: imageRefSchema },
  },
} as const

/** Agent calls stay pending until the provider and history write settle. */
const AGENT_GENERATION_TIMEOUT_MS = 300_000

function acceptedMediaType(value: string): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function projectRef(ref: ImageAttachmentRef): AgentImageRef {
  return {
    attachment_id: String(ref.attachmentId),
    media_type: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...ref.name === undefined ? {} : { name: ref.name },
  }
}

function restoreRef(value: AgentImageRef): ImageAttachmentRef {
  if (!acceptedMediaType(value.media_type)) throw new ImageGenError('source_image.media_type is not a supported image type', 'bad-reference-image')
  if (!Number.isInteger(value.bytes) || value.bytes < 1 || !Number.isInteger(value.width) || value.width < 1 || !Number.isInteger(value.height) || value.height < 1) {
    throw new ImageGenError('source_image metadata is invalid', 'bad-reference-image')
  }
  return {
    attachmentId: value.attachment_id as ImageAttachmentRef['attachmentId'],
    mediaType: value.media_type,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    ...value.name === undefined ? {} : { name: value.name },
  }
}

function imageDataUrl(image: { data: Uint8Array; ref: ImageAttachmentRef }): string {
  return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
}

function renderTaskResult(value: AgentTaskResult): Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }> {
  const text = JSON.stringify(value)
  return [
    { type: 'text', text },
    ...value.images.map(image => ({ type: 'image' as const, attachment: restoreRef(image) })),
  ]
}

/** Register the global Agent tools and unregister them with the plugin lifecycle. */
export function registerAgentImageTools(ctx: Context, runtime: ImageGenerationRuntime, resolve: () => AgentImageToolConfig): () => void {
  const attachmentRefs = new Map<string, Promise<AgentImageRef[]>>()
  const ensureConfigured = (): void => {
    const config = resolve()
    if (!config.enabled) throw new ImageGenError('AI image generation is disabled. Open Settings > Plugins > AI Image and enable it.', 'plugin-disabled')
    if (!config.allowAgentImageGeneration) throw new ImageGenError('Agent image generation is disabled in Settings > Plugins > AI Image.', 'agent-generation-disabled')
    if (config.apiUrl.trim() === '' || config.apiKey.trim() === '') throw new ImageGenError('Image API credentials are not configured. Open Settings > Plugins > AI Image and fill in API URL and API key.', 'image-api-not-configured')
  }
  const selectedModel = (requested: unknown): string => {
    const models = normalizeImageModels(resolve().imageModels)
    const model = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : models[0]
    if (!models.includes(model)) {
      throw new ImageGenError(`Image model "${model}" is not configured. Choose one of: ${models.join(', ')}.`, 'image-model-not-configured')
    }
    return model
  }
  const materializeTaskImages = (task: GenerationTask): Promise<AgentImageRef[]> => {
    if (task.status !== 'completed') return Promise.resolve([])
    const existing = attachmentRefs.get(task.id)
    if (existing !== undefined) return existing
    const pending = ctx.attachments.saveImages((task.result?.images ?? []).map((image, index) => toSaveImage(image, task.id, index)))
      .then(refs => refs.map(projectRef))
    attachmentRefs.set(task.id, pending)
    void pending.catch(() => {
      if (attachmentRefs.get(task.id) === pending) attachmentRefs.delete(task.id)
    })
    return pending
  }
  const taskResult = async (task: GenerationTask): Promise<AgentTaskResult> => {
    const images = await materializeTaskImages(task)
    return {
      task_id: task.id,
      status: task.status,
      message: task.status === 'completed'
        ? 'Generation completed. The images are attached below and can be reused as source_image in edit_image.'
        : task.status === 'failed'
          ? 'Generation failed.'
          : task.status === 'cancelled'
            ? 'Generation was cancelled.'
            : 'Generation is still running. Query the task again when you need its current status.',
      ...task.error === undefined ? {} : { error: task.error },
      images,
    }
  }
  const findTask = (id: string): GenerationTask => {
    const task = runtime.queue.list().find(candidate => candidate.id === id)
    if (task === undefined) throw new ImageGenError(`Image generation task ${id} was not found.`, 'task-not-found')
    return task
  }
  const waitForTask = (id: string, signal: AbortSignal | undefined): Promise<GenerationTask> => new Promise((resolveTask, rejectTask) => {
    let settled = false
    let dispose = (): void => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort = (): void => {}

    const cleanup = (): void => {
      dispose()
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const resolve = (task: GenerationTask): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveTask(task)
    }
    const reject = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectTask(error)
    }
    abort = (): void => {
      if (settled) return
      const reason = signal?.reason instanceof Error ? signal.reason : new Error('Image generation was cancelled.')
      // Remove the listener before publishing cancellation so the queue event
      // cannot turn an execution abort into a successful cancelled result.
      settled = true
      cleanup()
      runtime.queue.cancel(id)
      rejectTask(reason)
    }
    const onChange = (updated: GenerationTask): void => {
      if (updated.id === id && isFinalTask(updated)) resolve(updated)
    }

    if (signal?.aborted === true) {
      abort()
      return
    }
    dispose = runtime.queue.subscribe(onChange)
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => {
      if (settled) return
      const timeout = new ImageGenError(`Image generation task ${id} timed out after ${AGENT_GENERATION_TIMEOUT_MS / 1000} seconds.`, 'generation-timeout')
      settled = true
      cleanup()
      runtime.queue.cancel(id)
      rejectTask(timeout)
    }, AGENT_GENERATION_TIMEOUT_MS)
    let current: GenerationTask
    try {
      current = findTask(id)
    } catch (error) {
      reject(error)
      return
    }
    if (isFinalTask(current)) resolve(current)
  })
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'generate_image',
      description: 'Generate an image. By default this tool call stays pending until the task reaches a final state, and completed images are returned directly as tool-result attachments without creating a user message. Set wait_for_completion to false for background mode, then use get_image_generation_task explicitly. Only use models configured for this plugin; omit model to use the first configured image model.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'Detailed image-generation prompt.' },
        model: { type: 'string', description: 'One of the configured image models. Defaults to the first configured model.' },
        size: { type: 'string', description: 'Aspect ratio such as 1:1, 16:9, 9:16, or auto.' },
        quality: { type: 'string', description: 'auto, 1k, 2k, or 4k.' },
        count: { type: 'integer', description: 'Number of images, 1 to 4. Defaults to 1.' },
        detail: { type: 'string', description: 'Optional provider detail value, for example standard or high.' },
        wait_for_completion: { type: 'boolean', description: 'Wait for images and return them in this tool result. Defaults to true; set false for background mode.' },
      },
      output: { schema: taskResultSchema, render: (_args, value) => renderTaskResult(value) },
      async execute(args, exec) {
        ensureConfigured()
        const task = runtime.queue.submit({
          mode: 'text',
          model: selectedModel(args.model),
          prompt: args.prompt.trim(),
          size: args.size ?? 'auto',
          quality: args.quality ?? 'auto',
          n: Math.min(4, Math.max(1, args.count ?? 1)),
          detail: args.detail ?? '',
        })
        return taskResult(args.wait_for_completion === false ? task : await waitForTask(task.id, exec.signal))
      },
    })),
    ctx.tools.register(defineTool({
      name: 'edit_image',
      description: 'Edit an image. By default this tool call stays pending until the task reaches a final state, and completed images are returned directly as tool-result attachments without creating a user message. Set wait_for_completion to false for background mode, then use get_image_generation_task explicitly. source_image must be an image reference returned by a completed generation or get_image_generation_task; pass that entire object unchanged. Only configured image models are allowed; omit model to use the first configured model.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'How to transform the source image.' },
        source_image: { ...imageRefSchema, required: true, description: 'Image reference returned by get_image_generation_task.' },
        model: { type: 'string', description: 'One of the configured image models. Defaults to the first configured model.' },
        size: { type: 'string', description: 'Aspect ratio such as 1:1, 16:9, 9:16, or auto.' },
        quality: { type: 'string', description: 'auto, 1k, 2k, or 4k.' },
        count: { type: 'integer', description: 'Number of images, 1 to 4. Defaults to 1.' },
        detail: { type: 'string', description: 'Optional provider detail value.' },
        wait_for_completion: { type: 'boolean', description: 'Wait for images and return them in this tool result. Defaults to true; set false for background mode.' },
      },
      output: { schema: taskResultSchema, render: (_args, value) => renderTaskResult(value) },
      async execute(args, exec) {
        ensureConfigured()
        const reference = await ctx.attachments.readImage(restoreRef(args.source_image), exec.signal)
        const task = runtime.queue.submit({
          mode: 'edit',
          model: selectedModel(args.model),
          prompt: args.prompt.trim(),
          size: args.size ?? 'auto',
          quality: args.quality ?? 'auto',
          n: Math.min(4, Math.max(1, args.count ?? 1)),
          detail: args.detail ?? '',
          image: imageDataUrl(reference),
          ...reference.ref.name === undefined ? {} : { refName: reference.ref.name },
        })
        return taskResult(args.wait_for_completion === false ? task : await waitForTask(task.id, exec.signal))
      },
    })),
    ctx.tools.register(defineTool({
      name: 'get_image_generation_task',
      description: 'Check an image-generation task status. Completed tasks return image references and image attachments for edit_image. Generation tools normally wait for completion, so use this for explicit recovery or status checks.',
      parameters: { task_id: { type: 'string', required: true, description: 'Task id returned by generate_image or edit_image.' } },
      output: { schema: taskResultSchema, render: (_args, value) => renderTaskResult(value) },
      async execute(args) {
        ensureConfigured()
        return taskResult(findTask(args.task_id))
      },
    })),
    ctx.tools.register(defineTool({
      name: 'cancel_image_generation_task',
      description: 'Cancel a queued or running image generation task.',
      parameters: { task_id: { type: 'string', required: true, description: 'Task id returned by generate_image or edit_image.' } },
      output: { schema: taskResultSchema, render: (_args, value) => renderTaskResult(value) },
      async execute(args) {
        ensureConfigured()
        const task = runtime.queue.cancel(args.task_id)
        if (task === undefined) throw new ImageGenError(`Image generation task ${args.task_id} was not found.`, 'task-not-found')
        return taskResult(task)
      },
    })),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

function isFinalTask(task: GenerationTask): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
}

function toSaveImage(image: GeneratedImage, taskId: string, index: number): { data: Uint8Array; mediaType: ImageMediaType; name: string } {
  const mediaType = acceptedMediaType(image.mime) ? image.mime : 'image/png'
  return {
    data: Buffer.from(image.b64, 'base64'),
    mediaType,
    name: `imagegen-${taskId}-${index + 1}.${mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length)}`,
  }
}
