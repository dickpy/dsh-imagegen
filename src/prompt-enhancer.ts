/** OpenAI-compatible chat helpers used by the optional prompt-enhancement UI. */

export interface PromptModelConfig {
  apiUrl: string
  apiKey: string
  model: string
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

/** List chat models exposed by an OpenAI-compatible endpoint. */
export async function listPromptModels(config: PromptModelConfig): Promise<string[]> {
  if (config.apiUrl.trim() === '') throw new Error('prompt enhancement API URL is required')
  const response = await fetch(endpoint(config.apiUrl, '/models'), { headers: headers(config.apiKey) })
  const body = await responseJson(response)
  const data = Array.isArray(body.data) ? body.data : []
  return data
    .flatMap(item => item !== null && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' ? [(item as { id: string }).id] : [])
    .sort((a, b) => a.localeCompare(b))
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
