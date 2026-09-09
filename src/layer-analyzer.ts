/**
 * Canvas layer decomposition (the 图层拆分 / magic-layers tool).
 *
 * The host asks the configured *chat* model — the same OpenAI-compatible
 * endpoint the prompt enhancer uses — to read the picture and answer with a
 * strict JSON layer plan (background / object / text). The browser half then
 * rasterizes that plan into real canvas nodes: text layers become editable text
 * nodes, object layers are cropped and locally matted into transparent PNGs,
 * and the background layer reuses the source asset.
 *
 * Nothing here is trusted: the model output is normalized, clamped and
 * length-capped before it reaches the client.
 */

import { stripReasoning, type PromptModelConfig } from './prompt-enhancer.ts'
import type { CanvasLayerKind, CanvasLayerPlan, CanvasLayerPlanItem, CanvasRect } from './protocol.ts'

/** Cap on the image payload accepted for analysis (base64 data URL). */
export const MAX_LAYER_IMAGE_BYTES = 12 * 1024 * 1024

/** Hard cap on layers, so a chatty model cannot flood the canvas. */
const MAX_LAYERS = 16

/** Cap on recognized text length per text layer. */
const MAX_LAYER_TEXT = 200

const LAYER_SYSTEM_PROMPT = [
  '你是图像图层拆解引擎。用户会给你一张图片，请把它拆成可独立编辑的图层，并且只输出一个 JSON 对象，不要输出任何解释、markdown 或代码块。',
  '输出格式：',
  '{"layers":[{"kind":"background","label":"背景"},{"kind":"object","label":"人物","rect":{"x":0.1,"y":0.2,"width":0.3,"height":0.5}},{"kind":"text","label":"标题","rect":{"x":0.2,"y":0.05,"width":0.6,"height":0.12},"text":"识别出的文字","color":"#ffffff"}]}',
  '规则：',
  '1. rect 使用相对图片的归一化坐标（0~1，原点在左上角），必须是紧贴该元素的矩形框。',
  '2. kind 只能是 background / object / text。background 层不要 rect，只允许一个，排在最前面。',
  '3. text 层必须尽量识别出准确的文字内容（保持原语言与换行），并给出文字颜色（十六进制，如 #ffffff）。',
  '4. 人物、商品、装饰元素、图标等前景元素各占一个 object 层，最多 10 个，按视觉重要性排序。',
  '5. 不要臆造看不见的元素；识别不到文字就不要输出 text 层。',
].join('\n')

function clamp01(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

/** Normalize one raw rectangle; undefined when it is degenerate. */
function rectOf(value: unknown): CanvasRect | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  // Accept both {x,y,width,height} and {x,y,w,h} / [x0,y0,x1,y1]-ish shapes.
  let x = clamp01(raw.x)
  let y = clamp01(raw.y)
  let width = clamp01(raw.width ?? raw.w)
  let height = clamp01(raw.height ?? raw.h)
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    const x2 = clamp01(raw.x2 ?? raw.right)
    const y2 = clamp01(raw.y2 ?? raw.bottom)
    if (x === undefined || y === undefined || x2 === undefined || y2 === undefined) return undefined
    width = Math.max(0, x2 - x)
    height = Math.max(0, y2 - y)
  }
  // A model may report the box as center + size.
  if (width === 0 || height === 0) return undefined
  if (x + width > 1) width = 1 - x
  if (y + height > 1) height = 1 - y
  if (width < 0.005 || height < 0.005) return undefined
  return { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)), width: Number(width.toFixed(4)), height: Number(height.toFixed(4)) }
}

function colorOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed) || /^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase()
  return undefined
}

function labelOf(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed === '' ? fallback : trimmed.slice(0, 40)
}

const KIND_LABEL: Record<CanvasLayerKind, string> = { background: '背景', object: '元素', text: '文字' }

/** Validate + normalize one raw layer entry. */
function layerOf(value: unknown): CanvasLayerPlanItem | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const kind = raw.kind ?? raw.type
  if (kind !== 'background' && kind !== 'object' && kind !== 'text') return undefined
  const label = labelOf(raw.label ?? raw.name, KIND_LABEL[kind])
  if (kind === 'background') return { kind, label }
  const rect = rectOf(raw.rect ?? raw.box ?? raw.bounds)
  if (rect === undefined) return undefined
  if (kind === 'text') {
    const text = typeof raw.text === 'string' ? raw.text.trim() : typeof raw.content === 'string' ? raw.content.trim() : ''
    if (text === '') return undefined
    const color = colorOf(raw.color)
    return { kind, label, rect, text: text.slice(0, MAX_LAYER_TEXT), ...(color === undefined ? {} : { color }) }
  }
  return { kind, label, rect }
}

/** Pull the JSON object out of a model answer that may wrap it in prose/fences. */
function jsonPayload(content: string): unknown {
  const cleaned = stripReasoning(content).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try { return JSON.parse(cleaned.slice(start, end + 1)) as unknown } catch { return undefined }
}

/** Normalize a raw plan into the wire shape (background first, capped). */
export function normalizeLayerPlan(value: unknown): CanvasLayerPlan | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const list = Array.isArray(raw.layers) ? raw.layers : Array.isArray(value) ? value : undefined
  if (list === undefined) return undefined
  const parsed = list.flatMap(item => {
    const layer = layerOf(item)
    return layer === undefined ? [] : [layer]
  })
  if (parsed.length === 0) return undefined
  const order: Record<CanvasLayerKind, number> = { background: 0, object: 1, text: 2 }
  const layers = parsed
    .sort((a, b) => order[a.kind] - order[b.kind])
    .filter((layer, index, all) => layer.kind !== 'background' || all.findIndex(item => item.kind === 'background') === index)
    .slice(0, MAX_LAYERS)
  return { layers }
}

/**
 * Decompose one image into a layer plan through the configured chat model.
 * The image travels as an OpenAI-style `image_url` data URL, so the model must
 * accept vision input; endpoints without it answer with an upstream error that
 * is surfaced verbatim.
 */
export async function analyzeLayers(config: PromptModelConfig, image: string): Promise<CanvasLayerPlan> {
  if (config.apiUrl.trim() === '' || config.model.trim() === '') {
    throw new Error('图层拆分需要先在「设置 → 插件 → AI 生图 → 提示词增强」配置一个支持视觉的聊天模型（API 地址 + 模型）')
  }
  const response = await fetch(`${config.apiUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...config.apiKey.trim() === '' ? {} : { authorization: `Bearer ${config.apiKey.trim()}` },
    },
    body: JSON.stringify({
      model: config.model.trim(),
      temperature: 0.2,
      messages: [
        { role: 'system', content: LAYER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请拆解这张图片的图层，只输出 JSON。' },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
    }),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = body !== null && typeof body === 'object'
      ? (body as { error?: { message?: unknown } }).error?.message
      : undefined
    throw new Error(typeof message === 'string' && message !== '' ? message : `HTTP ${response.status}`)
  }
  const choices = body !== null && typeof body === 'object' && Array.isArray((body as { choices?: unknown }).choices)
    ? (body as { choices: unknown[] }).choices
    : []
  const content = choices[0] !== null && typeof choices[0] === 'object'
    ? (choices[0] as { message?: { content?: unknown } }).message?.content
    : undefined
  if (typeof content !== 'string' || content.trim() === '') throw new Error('聊天模型没有返回图层数据')
  const plan = normalizeLayerPlan(jsonPayload(content))
  if (plan === undefined) throw new Error('聊天模型返回的图层 JSON 无法解析（可能不支持视觉输入）')
  return plan
}
