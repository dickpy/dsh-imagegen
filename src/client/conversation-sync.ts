import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ConversationController, IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** Document event used to bridge chat tool results into the image workspace. */
export const CHAT_IMAGE_EVENT = 'dsh-imagegen:chat-images'

export interface ChatImageEventDetail {
  sessionId: SessionId
  refs: readonly ImageAttachmentRef[]
}

/** Composer-facing extension of the narrower public conversation interface. */
export type ConversationService = IConversation & Pick<ConversationController, 'createDraftImages' | 'releaseDraftImages'>
