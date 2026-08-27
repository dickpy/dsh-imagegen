/** OpenAI-compatible chat helpers used by the optional prompt-enhancement UI. */

import { isLikelyImageModelId } from './model-catalog.ts'

export interface PromptModelConfig {
  apiUrl: string
  apiKey: string
  model: string
}

/** Credentials shared by OpenAI-compatible `/models` discovery. */
export interface ModelListConfig {
  apiUrl: string
  apiKey: string
}

function endpoint(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}${suffix}`
}

function headers(apiKey: string): HeadersInit {
  return {
    'content-type': 'application/json',
    ...apiKey.trim() === '' ? {} : { authorization: `Bearer ${apiKey.trim()}` },
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok || body === undefined || body === null || typeof body !== 'object') {
    const message = body !== null && typeof body === 'object' && typeof (body as { error?: { message?: unknown } }).error?.message === 'string'
      ? (body as { error: { message: string } }).error.message
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body as Record<string, unknown>
}

type ModelRecord = Record<string, unknown> & { id: string }

async function listModelRecords(config: ModelListConfig): Promise<ModelRecord[]> {
  if (config.apiUrl.trim() === '') throw new Error('API URL is required')
  const response = await fetch(endpoint(config.apiUrl, '/models'), { headers: headers(config.apiKey) })
  const body = await responseJson(response)
  const data = Array.isArray(body.data) ? body.data : []
  return data.flatMap(item => {
    if (item === null || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string') return []
    const id = (item as { id: string }).id.trim()
    return id === '' ? [] : [{ ...(item as Record<string, unknown>), id }]
  })
}

function textOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function hasImageGenerationCapability(record: ModelRecord): boolean | undefined {
  const capability = record.capabilities
  if (capability !== null && typeof capability === 'object') {
    const values = capability as Record<string, unknown>
    for (const key of ['image_generation', 'imageGeneration', 'text_to_image', 'textToImage', 'image_gen']) {
      if (typeof values[key] === 'boolean') return values[key]
    }
    const serialized = JSON.stringify(values).toLowerCase()
    if (/image[ _-]?generation|text[ _-]?to[ _-]?image/.test(serialized)) return true
  }

  const taskText = [
    ...textOf(record.task),
    ...textOf(record.task_type),
    ...textOf(record.taskType),
    ...textOf(record.type),
    ...textOf(record.model_type),
    ...textOf(record.modelType),
    ...textOf(record.tasks),
    ...textOf(record.description),
  ].join(' ').toLowerCase()
  if (/image[ _-]?generation|text[ _-]?to[ _-]?image|image[ _-]?gen/.test(taskText)) return true
  if (/^image(?:[ _-]?generation)?$/.test(taskText.trim())) return true
  if (/embedding|rerank|moderation|transcri|speech|audio|video|chat[ _-]?completion/.test(taskText)) return false

  for (const key of ['output_modalities', 'outputModalities', 'supported_output_modalities']) {
    const modalities = textOf(record[key]).map(value => value.toLowerCase())
    if (modalities.length > 0) return modalities.includes('image')
  }
  return undefined
}

function isImageModelRecord(record: ModelRecord): boolean {
  return hasImageGenerationCapability(record) ?? isLikelyImageModelId(record.id)
}

/** List candidates exposed by an OpenAI-compatible endpoint. */
export async function listOpenAIModels(config: ModelListConfig): Promise<string[]> {
  return [...new Set((await listModelRecords(config)).map(record => record.id))]
    .sort((a, b) => a.localeCompare(b))
}

/** List only models that advertise or conventionally represent image generation. */
export async function listImageModels(config: ModelListConfig): Promise<string[]> {
  return [...new Set((await listModelRecords(config)).filter(isImageModelRecord).map(record => record.id))]
    .sort((a, b) => a.localeCompare(b))
}

/** List chat models exposed by an OpenAI-compatible endpoint. */
export async function listPromptModels(config: PromptModelConfig): Promise<string[]> {
  return listOpenAIModels(config)
}

/** Expand a concise image request into a production-ready image prompt. */
export async function enhancePrompt(config: PromptModelConfig, prompt: string): Promise<string> {
  if (config.apiUrl.trim() === '' || config.model.trim() === '') throw new Error('prompt enhancement model is not configured')
  const response = await fetch(endpoint(config.apiUrl, '/chat/completions'), {
    method: 'POST',
    headers: headers(config.apiKey),
    body: JSON.stringify({
      model: config.model.trim(),
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: 'You are an expert image-prompt editor. Expand the user request into one vivid, specific image-generation prompt. Preserve intent and language. Add only useful visual detail: subject, composition, lighting, materials, color, camera/style and quality. Return only the finished prompt, with no preface or markdown.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  })
  const body = await responseJson(response)
  const choices = Array.isArray(body.choices) ? body.choices : []
  const content = choices[0] !== null && typeof choices[0] === 'object'
    ? (choices[0] as { message?: { content?: unknown } }).message?.content
    : undefined
  if (typeof content !== 'string' || content.trim() === '') throw new Error('chat model returned an empty prompt')
  return content.trim()
}
