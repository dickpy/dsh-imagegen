/** Direct `/edit_image` command for editing the latest image in the session. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-attachment'
import {
  submitAgentImageEdit,
  type AgentImageToolConfig,
} from './agent-image-tools.ts'
import type { ImageGenerationRuntime } from './generation-runtime.ts'

function isImageReference(value: unknown): value is ImageAttachmentRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return typeof ref.attachmentId === 'string'
    && (ref.mediaType === 'image/png' || ref.mediaType === 'image/jpeg' || ref.mediaType === 'image/webp' || ref.mediaType === 'image/gif')
    && Number.isInteger(ref.bytes) && (ref.bytes as number) > 0
    && Number.isInteger(ref.width) && (ref.width as number) > 0
    && Number.isInteger(ref.height) && (ref.height as number) > 0
}

function imageInContent(value: unknown): ImageAttachmentRef | undefined {
  if (!Array.isArray(value)) return undefined
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const block = value[index]
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue
    const raw = block as Record<string, unknown>
    if (raw.type === 'image' && isImageReference(raw.attachment)) return raw.attachment
    if (raw.type === 'tool-result') {
      const nested = imageInContent(raw.content)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Pick the newest image explicitly attached to this command invocation. */
function imageInInvocation(value: unknown): ImageAttachmentRef | undefined {
  if (!Array.isArray(value)) return undefined
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const block = value[index]
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue
    const raw = block as Record<string, unknown>
    if (raw.type === 'image' && isImageReference(raw.attachment)) return raw.attachment
  }
  return undefined
}

/** Find the newest durable image reference, including nested tool results. */
export function latestSessionImage(messages: readonly unknown[]): ImageAttachmentRef | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    const image = imageInContent((message as { content?: unknown }).content)
    if (image !== undefined) return image
  }
  return undefined
}

function commandError(error: unknown): CommandResult {
  const text = error instanceof Error ? error.message : String(error)
  return { kind: 'error', text: text.trim() === '' ? '图片编辑失败。' : text }
}

/** Register the host-side command; it never sends the command line to a chat model. */
export function registerEditImageCommand(
  ctx: Context,
  runtime: ImageGenerationRuntime,
  resolve: () => AgentImageToolConfig,
  pendingImages?: {
    get: (sessionId: string) => ImageAttachmentRef | undefined
    consume: (sessionId: string, ref: ImageAttachmentRef) => void
  },
): () => void {
  return ctx.commands.register({
    name: 'edit_image',
    description: 'Edit the latest image in this conversation with the plugin image model',
    // `images` is understood by the newer host command protocol. Keep the
    // source compatible with older development-only command typings.
    input: { hint: 'Describe how to modify the latest image', images: true } as { hint: string; images: boolean },
    async handler(invocation): Promise<CommandResult> {
      const prompt = invocation.rawInput.trim()
      if (prompt === '') return { kind: 'error', text: '请提供图片修改描述，例如：/edit_image 把背景改成夜景' }
      const invocationImage = imageInInvocation((invocation as typeof invocation & { attachments?: readonly unknown[] }).attachments)
      // A staged composer image is newer than anything already committed to
      // the session, so it must win when the user explicitly adds a preview
      // or gallery image before running the command.
      const pendingImage = pendingImages?.get(String(invocation.agent.id))
      const durableImage = latestSessionImage(invocation.agent.session.deriveMessages())
      const sourceImage = invocationImage ?? pendingImage ?? durableImage
      if (sourceImage === undefined) return { kind: 'error', text: '当前对话没有可用图片，请先上传图片或把画廊图片加入对话。' }
      try {
        const task = await submitAgentImageEdit(ctx.attachments as Pick<AttachmentStore, 'readImage'>, runtime, resolve, {
          prompt,
          sourceImage,
          signal: invocation.signal,
        })
        if (task.status === 'completed') {
          if (pendingImage !== undefined) pendingImages?.consume(String(invocation.agent.id), pendingImage)
          return { kind: 'success', text: '图片编辑已完成，可在 AI 生图面板查看结果。' }
        }
        return { kind: 'error', text: task.error ?? `图片编辑${task.status === 'cancelled' ? '已取消' : '失败'}。` }
      } catch (error) {
        return commandError(error)
      }
    },
  })
}
