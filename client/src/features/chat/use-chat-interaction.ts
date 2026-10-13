import { useStore } from '@nanostores/react'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'

import { ChatInteraction, type ChatInteractionCommands, type ChatInteractionState, type ChatMediaConnection } from '~/features/chat/chat-interaction'
import { chatDrafts } from './chat-drafts'
import { $draftOwner } from '~/state/draft-owner'
import { $preferences } from '~/state/store'
import { $chat, type Conversation } from '~/state/conversation'

export interface UseChatInteractionResult {
  interaction: ChatInteraction
  state: ChatInteractionState
}

export function useChatInteraction({ conversation, mediaConnection }: {
  conversation: Conversation
  mediaConnection: ChatMediaConnection
}): UseChatInteractionResult {
  const draftVersion = useStore(chatDrafts.$version)
  const chat = useStore($chat)
  const owner = useStore($draftOwner)
  const preferences = useStore($preferences)
  // A fresh literal, not the live instances: every method must be bound so
  // `this` resolves to its owner (Conversation).
  const commands = useMemo<ChatInteractionCommands>(() => ({
    isCurrent: (context, runtimeId) => {
      const owner = $draftOwner.get()
      const chat = $chat.get()
      return !owner.locked && owner.generation === context.owner.generation
        && $preferences.get().profile === context.profile && runtimeId === chat.runtimeSessionId
        && (context.provisional || context.conversation === chat.storedSessionId)
    },
    attach: conversation.attach.bind(conversation),
    completeSlash: conversation.completeSlash.bind(conversation),
    retryFrom: conversation.retryFrom.bind(conversation),
    send: conversation.send.bind(conversation)
  }), [conversation])
  const interaction = useMemo(() => new ChatInteraction(commands, mediaConnection, chatDrafts), [commands, mediaConnection])
  const pendingDisposals = useRef(new Map<ChatInteraction, symbol>())

  useEffect(() => {
    // StrictMode rehearses effect cleanup without replacing the memoized instance.
    pendingDisposals.current.delete(interaction)
    return () => {
      const disposal = Symbol('chat-interaction-disposal')
      pendingDisposals.current.set(interaction, disposal)
      queueMicrotask(() => {
        if (pendingDisposals.current.get(interaction) !== disposal) return
        pendingDisposals.current.delete(interaction)
        interaction.dispose()
      })
    }
  }, [interaction])

  useLayoutEffect(() => {
    interaction.setContext({ owner, profile: preferences.profile, conversation: chat.storedSessionId ?? chatDrafts.provisionalId(owner, preferences.profile, chat.runtimeSessionId), provisional: !chat.storedSessionId }, chat.runtimeSessionId)
  }, [chat.runtimeSessionId, chat.storedSessionId, owner, preferences.profile, interaction])

  useLayoutEffect(() => { interaction.sync() }, [draftVersion, interaction])

  const state = useStore(interaction.$state)
  return { interaction, state }
}