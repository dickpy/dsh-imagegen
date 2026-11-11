/** Read dimensions from raster headers without decoding or allocating pixels. */
export function imageDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const valid = (width: number, height: number): { width: number; height: number } | undefined => width > 0 && height > 0 && width <= 100000 && height <= 100000 ? { width, height } : undefined
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.toString('ascii', 12, 16) === 'IHDR') return valid(b.readUInt32BE(16), b.readUInt32BE(20))
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return valid(b.readUInt16LE(6), b.readUInt16LE(8))
  if (b.length >= 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    for (let offset = 12; offset + 8 <= b.length;) {
      const tag = b.toString('ascii', offset, offset + 4), length = b.readUInt32LE(offset + 4), p = offset + 8
      if (length > b.length - p) return undefined
      if (tag === 'VP8X' && length >= 10) return valid(1 + b.readUIntLE(p + 4, 3), 1 + b.readUIntLE(p + 7, 3))
      if (tag === 'VP8L' && length >= 5 && b[p] === 0x2f) {
        const bits = b.readUInt32LE(p + 1)
        return valid(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff))
      }
      if (tag === 'VP8 ' && length >= 10 && b[p + 3] === 0x9d && b[p + 4] === 0x01 && b[p + 5] === 0x2a) return valid(b.readUInt16LE(p + 6) & 0x3fff, b.readUInt16LE(p + 8) & 0x3fff)
      offset = p + length + (length % 2)
    }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let offset = 2; offset < b.length;) {
      if (b[offset++] !== 0xff) continue
      while (offset < b.length && b[offset] === 0xff) offset++
      const marker = b[offset++]!
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > b.length) return undefined
      const length = b.readUInt16BE(offset)
      if (length < 2 || offset + length > b.length) return undefined
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) return valid(b.readUInt16BE(offset + 5), b.readUInt16BE(offset + 3))
      offset += length
    }
  }
  return undefined
}
