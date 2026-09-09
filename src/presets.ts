/**
 * Built-in provider catalog (presets). A preset is an official or well-known
 * OpenAI-compatible endpoint with its known model list, so the user only fills
 * in the API key. The list ships with the package and is served to the
 * settings card through a host route, so it can later be refreshed online like
 * the template library.
 *
 * Framework-free (pure data), safe for the host routes to serve directly.
 */

import type { ModelMapping } from './protocol.ts'

/** One built-in provider the settings card can instantiate a channel from. */
export interface PresetProvider {
  /** Stable preset id stored on channels created from it ('' = custom). */
  id: string
  /** Display name shown in the picker (also the channel's default name). */
  name: string
  /** Official base URL prefilled into the channel. */
  apiUrl: string
  /** One-line description shown in the picker. */
  hint: string
  /** Known model list prefilled into the channel's model catalog. */
  models: ModelMapping[]
}

export const IMAGE_PRESETS: PresetProvider[] = [
  {
    id: 'volc-ark-seedream',
    name: '字节 · 火山方舟（Seedream）',
    apiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    hint: '字节跳动官方 Seedream 文生图/图生图入口',
    models: [
      { alias: 'seedream-5.0-pro', id: 'seedream-5.0-pro' },
      { alias: 'seedream-5.0', id: 'seedream-5.0' },
      { alias: 'seedream-4.0', id: 'seedream-4.0' },
    ],
  },
  {
    id: 'openai-official',
    name: 'OpenAI 官方',
    apiUrl: 'https://api.openai.com/v1',
    hint: 'OpenAI 官方图像生成接口（gpt-image-2.5 支持手绘草图生图）',
    models: [
      { alias: 'gpt-image-2.5', id: 'gpt-image-2.5' },
      { alias: 'gpt-image-2', id: 'gpt-image-2' },
    ],
  },
  {
    id: 'zhipu-official',
    name: '智谱 AI 官方',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4',
    hint: '智谱官方 GLM-Image 图像生成接口',
    models: [
      { alias: 'glm-image', id: 'glm-image' },
    ],
  },
  {
    id: 'aliyun-dashscope-qwen',
    name: '阿里云百炼（Qwen-Image）',
    apiUrl: 'https://dashscope.aliyuncs.com/api/v1',
    hint: '阿里云百炼 DashScope 原生接口：通义千问 Qwen-Image 系列（该渠道不可复用于提示词增强）',
    models: [
      { alias: 'qwen-image-3.0-pro', id: 'qwen-image-3.0-pro' },
      { alias: 'qwen-image-3.0', id: 'qwen-image-3.0' },
      { alias: 'qwen-image-2.0-pro', id: 'qwen-image-2.0-pro' },
      { alias: 'qwen-image-2.0', id: 'qwen-image-2.0' },
      { alias: 'qwen-image-max', id: 'qwen-image-max' },
      { alias: 'qwen-image-plus', id: 'qwen-image-plus' },
      { alias: 'qwen-image', id: 'qwen-image' },
    ],
  },
  {
    id: 'minimax-official',
    name: 'MiniMax 官方（国际站）',
    apiUrl: 'https://api.minimax.io/v1',
    hint: 'MiniMax 原生 /image_generation 接口：image-01（国内站请把地址改为 https://api.minimaxi.com/v1；/models 不列出图片模型，请直接使用预填目录）',
    models: [
      { alias: 'image-01', id: 'image-01' },
    ],
  },
  {
    id: 'xai-grok',
    name: 'xAI（Grok）',
    apiUrl: 'https://api.x.ai/v1',
    hint: 'xAI 官方接口：Grok Imagine 系列',
    models: [
      { alias: 'grok-imagine-image', id: 'grok-imagine-image' },
    ],
  },
]

/** Look up one built-in provider by id. */
export function presetById(id: string): PresetProvider | undefined {
  return IMAGE_PRESETS.find(preset => preset.id === id)
}
