/**
 * dsh-imagegen — host half. Mounts the plugin's settings section (api_url /
 * api_key on the host settings seam), the /api/dsh-imagegen route family
 * (loopback-only settings bridge + image-generation proxy that keeps the API
 * key host-side), and a system-prompt announcement. The browser half
 * (./client) renders the sidebar entry and the split-pane generation studio.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
// Type-only: pulls the webServer Context merge (route registration).
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the systemPrompt Context merge (announcement section).
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import { IMAGEGEN_SETTINGS_NAMESPACE } from './protocol.ts'
import { makeRoutes, type SettingsSeam } from './routes.ts'
import { ImageGenerationRuntime } from './generation-runtime.ts'
import { registerAgentImageTools } from './agent-image-tools.ts'
import { DEFAULT_IMAGE_MODELS, normalizeImageModels } from './image-models.ts'

/** Stable cordis plugin name. */
export const name = 'imagegen'

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'systemPrompt']

// Internals re-exported for smoke tests and host-side debugging; the plugin
// contract only requires name / inject / Config / apply.
export { makeRoutes } from './routes.ts'
export { generateImage, ImageGenError } from './engine.ts'
export { ImageGenerationRuntime } from './generation-runtime.ts'
export { registerAgentImageTools } from './agent-image-tools.ts'
export { appendGallery, clearGallery, listGallery, readGalleryImage, removeGallery, updateGalleryTags } from './gallery-store.ts'
export { listTemplates, readTemplateImage, refreshTemplates, clearTemplateMemo } from './templates-store.ts'
export { checkForUpdate, clearUpdateCache, compareVersions, CURRENT_VERSION, installUpdate, profileFromProcess } from './updater.ts'

/** The branded settings namespace of this plugin (the card edits it). */
export const ImageGenSettingsNamespace = settingsNamespace(IMAGEGEN_SETTINGS_NAMESPACE)

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the plugin (routes, prompt section). */
  enabled?: boolean
  /** Announce the plugin in every agent's system prompt. */
  announceToAgent?: boolean
  /** Allow Agents to submit and retrieve image-generation tasks. */
  allowAgentImageGeneration?: boolean
  /** Base URL of the OpenAI-compatible endpoint, e.g. https://api.openai.com/v1 */
  apiUrl?: string
  /** Bearer API key (stored as a secret field on the settings seam). */
  apiKey?: string
  /** Explicit allow-list of image models selected for this API endpoint. */
  imageModels?: string[]
  /** Optional OpenAI-compatible chat endpoint for prompt enhancement. */
  promptApiUrl?: string
  /** Optional secret for the prompt enhancement endpoint. */
  promptApiKey?: string
  /** Chat model used to expand short image prompts. */
  promptModel?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  allowAgentImageGeneration: z.boolean().default(true),
  apiUrl: z.string().default(''),
  apiKey: z.string().role('secret').default(''),
  imageModels: z.array(z.string()).default([...DEFAULT_IMAGE_MODELS]),
  promptApiUrl: z.string().default(''),
  promptApiKey: z.string().role('secret').default(''),
  promptModel: z.string().default(''),
})

/** Schema defaults, re-read for hand-built contexts (the loader applies them normally). */
const DEFAULT_ENABLED = true
const DEFAULT_ANNOUNCE = true
const DEFAULT_ALLOW_AGENT_IMAGE_GENERATION = true

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const IMAGEGEN_GUIDANCE = '本机已安装 dsh-imagegen 插件（DSH AI 生图）：侧边栏「AI 生图」入口。能力：对接 OpenAI 兼容图像生成 API，模型由用户在「设置 → 插件 → AI 生图」中检测或手动配置的生图模型列表决定；支持文生图（/images/generations）与图生图（/images/edits，上传参考图，grok-imagine 模型按官方 JSON image_url 协议发送，nanobanana 系列按 aspect_ratio / image_size 参数协议发送；seedream 系列统一走 /images/generations，参考图以 JSON image 数组发送）。API 地址与密钥在 GUI 设置中配置，密钥仅存于本机设置文档；生成请求由本地宿主代理转发，结果以 base64 返回面板，可预览与下载。模型只能使用已配置的生图模型；模型出现在 /models 中不等于其网关原生支持生图协议，遇到 Qwen、Gemini 等非 OpenAI 生图协议时应如实说明上游兼容性。可一键把满意的图片加入「画廊」。内置「提示词模板库」（面板提示词框左下角「模板库」按钮）：打包 awesome-gpt-image-2 的数百条提示词案例，可搜索、筛选与复用。Agent 可直接调用 `generate_image` 提交文生图，也可用 `edit_image` 图生图；默认保持工具调用等待直到任务完成，完成图片直接作为工具结果附件返回，不会额外伪造用户消息。若明确需要后台执行，可传 `wait_for_completion: false`，之后再用 `get_image_generation_task` 查询；不要反复轮询。限制：生成消耗上游 API 额度；图片内容由上游模型生成，可能不符合预期或包含不适宜内容；api_key 以明文存储在设置文档中；参考图会发送至所配置的 API 服务；模板库在线刷新与参考图首次加载需要访问 vibeui.top。用户提到「生图 / 绘画 / 生成图片 / 文生图 / 图生图 / 画廊 / 提示词模板」时即指本插件，请据此协作。'

/** Add the live allow-list so an Agent can honor a user's model choice. */
function guidanceFor(imageModels: string[]): string {
  return `${IMAGEGEN_GUIDANCE} 当前允许调用的生图模型：${imageModels.join('、')}。用户指定其中某个模型时，工具参数 model 必须使用该精确名称；未指定时使用列表中的第一个。`
}

/** Effective config (schema defaults applied). */
interface EffectiveConfig {
  enabled: boolean
  announceToAgent: boolean
  allowAgentImageGeneration: boolean
  apiUrl: string
  apiKey: string
  imageModels: string[]
  promptApiUrl: string
  promptApiKey: string
  promptModel: string
}

/**
 * Mount the settings section, routes, and announcement.
 * @param ctx - host plugin context carrying webServer/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  // The live source the surfaces read: the settings section once the settings
  // service is attached, the composition entry otherwise.
  let current: () => Config = () => config ?? {}
  const resolve = (): EffectiveConfig => {
    const value = current()
    return {
      enabled: value.enabled ?? DEFAULT_ENABLED,
      announceToAgent: value.announceToAgent ?? DEFAULT_ANNOUNCE,
      allowAgentImageGeneration: value.allowAgentImageGeneration ?? DEFAULT_ALLOW_AGENT_IMAGE_GENERATION,
      apiUrl: value.apiUrl ?? '',
      apiKey: value.apiKey ?? '',
      imageModels: normalizeImageModels(value.imageModels),
      promptApiUrl: value.promptApiUrl ?? '',
      promptApiKey: value.promptApiKey ?? '',
      promptModel: value.promptModel ?? '',
    }
  }

  // Browser endpoints and Agent tools share the exact same serial queue. This
  // keeps image persistence, cancellation, and retries coherent across both
  // entry points; Agent tools wait for their task result by default and render
  // images in the tool result instead of injecting a synthetic user message.
  const runtime = new ImageGenerationRuntime(() => {
    const value = resolve()
    return { apiUrl: value.apiUrl, apiKey: value.apiKey }
  })

  // The route family mounts once, gated on the settings seam (the bridge
  // serves it; without the seam there is nothing to expose). Route handlers
  // read resolve() per request, so config edits apply live. The settings
  // bridge deliberately keeps serving while the plugin is disabled — it is
  // how the user re-enables the plugin from the settings card.
  ctx.inject(['settings'], (sctx) => {
    const seam = sctx.get('settings') as unknown as SettingsSeam
    sctx.effect(
      () => {
        const routes = makeRoutes({
          settings: seam,
          resolve: () => {
            const value = resolve()
            return { apiUrl: value.apiUrl, apiKey: value.apiKey }
          },
          resolvePrompt: () => {
            const value = resolve()
            return {
              apiUrl: value.promptApiUrl.trim() || value.apiUrl,
              apiKey: value.promptApiKey.trim() || value.apiKey,
              model: value.promptModel,
            }
          },
          resolveImageModels: () => resolve().imageModels,
          runtime,
        })
        const disposers = routes.map(route => ctx.webServer.register(route))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-imagegen: routes',
    )
  })

  ctx.inject(['tools', 'attachments'], (tctx) => {
    tctx.effect(() => registerAgentImageTools(tctx, runtime, () => {
      const value = resolve()
      return {
        enabled: value.enabled,
        allowAgentImageGeneration: value.allowAgentImageGeneration,
        apiUrl: value.apiUrl,
        apiKey: value.apiKey,
        imageModels: value.imageModels,
      }
    }), 'dsh-imagegen: agent image tools')
  })

  // System-prompt announcement (toggled by settings changes).
  let disposeSection: (() => void) | undefined
  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    const value = resolve()
    if (!value.enabled || !value.announceToAgent) return
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:dsh-imagegen',
      order: SECTION_ORDER,
      text: guidanceFor(value.imageModels),
    })
  }

  installSettingsSection(ctx, ImageGenSettingsNamespace, Config, config ?? {}, {
    setSource: (source) => {
      current = source
      sync()
    },
    onChange: sync,
  })

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose installSettingsSection never fires its hooks).
  sync()
}
