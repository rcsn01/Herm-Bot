import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef } from 'react'

import { ChatInteraction, type ChatInteractionCommands, type ChatInteractionState, type ChatMediaConnection } from '~/features/chat/chat-interaction'
import { $chat, type Conversation } from '~/state/conversation'

export interface UseChatInteractionResult {
  interaction: ChatInteraction
  state: ChatInteractionState
}

export function useChatInteraction({ conversation, mediaConnection }: {
  conversation: Conversation
  mediaConnection: ChatMediaConnection
}): UseChatInteractionResult {
  const chat = useStore($chat)
  // A fresh literal, not the live instances: every method must be bound so
  // `this` resolves to its owner (Conversation).
  const commands = useMemo<ChatInteractionCommands>(() => ({
    attach: conversation.attach.bind(conversation),
    completeSlash: conversation.completeSlash.bind(conversation),
    retryFrom: conversation.retryFrom.bind(conversation),
    send: conversation.send.bind(conversation)
  }), [conversation])
  const interaction = useMemo(() => new ChatInteraction(commands, mediaConnection), [commands, mediaConnection])
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

  useEffect(() => {
    interaction.setSession(chat.runtimeSessionId)
  }, [chat.runtimeSessionId, chat.storedSessionId, interaction])

  const state = useStore(interaction.$state)
  return { interaction, state }
}