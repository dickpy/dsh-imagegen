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
import { IMAGEGEN_SETTINGS_NAMESPACE } from './protocol.ts'
import { makeRoutes, type SettingsSeam } from './routes.ts'

/** Stable cordis plugin name. */
export const name = 'imagegen'

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'systemPrompt']

// Internals re-exported for smoke tests and host-side debugging; the plugin
// contract only requires name / inject / Config / apply.
export { makeRoutes } from './routes.ts'
export { generateImage, ImageGenError } from './engine.ts'

/** The branded settings namespace of this plugin (the card edits it). */
export const ImageGenSettingsNamespace = settingsNamespace(IMAGEGEN_SETTINGS_NAMESPACE)

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the plugin (routes, prompt section). */
  enabled?: boolean
  /** Announce the plugin in every agent's system prompt. */
  announceToAgent?: boolean
  /** Base URL of the OpenAI-compatible endpoint, e.g. https://api.openai.com/v1 */
  apiUrl?: string
  /** Bearer API key (stored as a secret field on the settings seam). */
  apiKey?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  apiUrl: z.string().default(''),
  apiKey: z.string().role('secret').default(''),
})

/** Schema defaults, re-read for hand-built contexts (the loader applies them normally). */
const DEFAULT_ENABLED = true
const DEFAULT_ANNOUNCE = true

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const IMAGEGEN_GUIDANCE = '本机已安装 dsh-imagegen 插件（DSH AI 生图）：侧边栏「AI 生图」入口；本地插件（源码位于 E:\\dsh-plugin，独立于 dsh-web-ui 插件全家桶）。能力：对接 OpenAI 兼容图像生成 API（模型 gpt-image-2），支持文生图（/images/generations）与图生图（/images/edits，上传参考图）；API 地址与密钥在 GUI「设置 → 插件 → 可配置」中配置，密钥仅存于本机设置文档；生成请求由本地宿主代理转发，结果以 base64 返回面板，可预览与下载。限制：生成消耗上游 API 额度；图片内容由上游模型生成，可能不符合预期或包含不适宜内容；api_key 以明文存储在设置文档中；参考图会发送至所配置的 API 服务。用户提到「生图 / 绘画 / 生成图片 / gpt-image-2 / 文生图 / 图生图」时即指本插件，请据此协作。'

/** Effective config (schema defaults applied). */
interface EffectiveConfig {
  enabled: boolean
  announceToAgent: boolean
  apiUrl: string
  apiKey: string
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
      apiUrl: value.apiUrl ?? '',
      apiKey: value.apiKey ?? '',
    }
  }

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
        })
        const disposers = routes.map(route => ctx.webServer.register(route))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-imagegen: routes',
    )
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
      text: IMAGEGEN_GUIDANCE,
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
