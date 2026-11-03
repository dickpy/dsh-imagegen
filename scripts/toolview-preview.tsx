/** Fixture: the conversation's inline result view, with a stubbed attachment fetch. */
import { createRoot } from 'react-dom/client'
import { ImageToolView } from '../src/client/image-toolview.tsx'

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const bytes = Uint8Array.from(atob(TINY_PNG), character => character.charCodeAt(0))

// jsdom ships neither fetch nor object URLs; the view needs both to give <img>
// a src, and the test asserts the src the lightbox renders.
globalThis.fetch = (async () => ({
  ok: true,
  status: 200,
  blob: async () => new Blob([bytes], { type: 'image/png' }),
})) as unknown as typeof fetch
URL.createObjectURL = () => 'blob:mock/result'
URL.revokeObjectURL = () => { /* jsdom keeps no object-URL registry */ }

const images = [1, 2].map(index => ({
  attachmentId: `att-${index}`,
  mediaType: 'image/png',
  bytes: bytes.length,
  width: 1024,
  height: 1024,
  name: 'result',
}))

const block = {
  kind: 'tool-result',
  isError: false,
  content: [{
    type: 'text',
    text: JSON.stringify({ status: 'completed', message: '一张测试图片', images }),
  }],
}

createRoot(document.getElementById('root')!).render(<ImageToolView
  callId="call-1"
  toolName="generate_image"
  block={block as never}
  sessionId={'session-1' as never}
  openFile={() => { /* not exercised by this fixture */ }}
/>)
