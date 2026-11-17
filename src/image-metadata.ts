import type { GeneratedImage } from './protocol.ts'

/** Copy only public result identity and measured dimensions across store seams. */
export function pickImageMetadata(raw: object): Pick<GeneratedImage, 'width' | 'height' | 'model' | 'channelId' | 'channel' | 'upstream' | 'historyId' | 'historyImageIndex'> {
  const value = raw as Record<string, unknown>
  const result: ReturnType<typeof pickImageMetadata> = {}
  if (typeof value.width === 'number' && Number.isInteger(value.width) && value.width > 0 && typeof value.height === 'number' && Number.isInteger(value.height) && value.height > 0) {
    result.width = value.width; result.height = value.height
  }
  for (const key of ['model', 'channelId', 'channel', 'upstream', 'historyId'] as const) if (typeof value[key] === 'string') result[key] = value[key]
  if (Number.isInteger(value.historyImageIndex) && Number(value.historyImageIndex) >= 0) result.historyImageIndex = Number(value.historyImageIndex)
  return result
}
