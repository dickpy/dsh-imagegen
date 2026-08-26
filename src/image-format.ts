/** Detect the supported raster format from its encoded bytes. */
export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export function detectImageMime(data: Uint8Array): SupportedImageMime | undefined {
  const startsWith = (...bytes: number[]): boolean => bytes.every((value, index) => data[index] === value)
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (startsWith(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || startsWith(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) return 'image/gif'
  if (startsWith(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return undefined
}
