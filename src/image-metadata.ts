import type { GeneratedImage } from './protocol.ts'

/** Copy only public result identity and measured dimensions across store seams. */
export function pickImageMetadata(raw: object): Pick<GeneratedImage, 'width' | 'height' | 'model' | 'channelId' | 'channel' | 'upstream'> {
  const value = raw as Record<string, unknown>
  const result: ReturnType<typeof pickImageMetadata> = {}
  if (typeof value.width === 'number' && Number.isInteger(value.width) && value.width > 0 && typeof value.height === 'number' && Number.isInteger(value.height) && value.height > 0) {
    result.width = value.width; result.height = value.height
  }
  for (const key of ['model', 'channelId', 'channel', 'upstream'] as const) if (typeof value[key] === 'string') result[key] = value[key]
  return result
}
