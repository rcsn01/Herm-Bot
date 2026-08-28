import type { GatewayEvent } from '@hermes/shared'

import type { ChatState, PendingPrompt, ToolActivity, TranscriptMessage } from '~/lib/types'

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

export const emptyChatState = (): ChatState => ({
  contractVersion: null,
  error: null,
  info: null,
  messages: [],
  pendingPrompt: null,
  running: false,
  runtimeSessionId: null,
  storedSessionId: null,
  tools: []
})

function updateLastAssistant(messages: TranscriptMessage[], delta: string, streaming = true) {
  const result = [...messages]
  const last = result.at(-1)
  if (last?.role === 'assistant') {
    result[result.length - 1] = { ...last, content: `${last.content}${delta}`, streaming }
  } else {
    result.push({ content: delta, id: crypto.randomUUID(), role: 'assistant', streaming })
  }
  return result
}

function upsertTool(tools: ToolActivity[], payload: Record<string, unknown>, status: ToolActivity['status']) {
  const id = text(payload.tool_call_id ?? payload.id) || `${text(payload.name)}-${tools.length}`
  const next: ToolActivity = {
    detail: text(payload.output ?? payload.detail ?? payload.message),
    id,
    name: text(payload.name ?? payload.tool_name) || 'Tool',
    status
  }
  const index = tools.findIndex(tool => tool.id === id)
  if (index < 0) return [...tools, next]
  const result = [...tools]
  result[index] = { ...result[index], ...next }
  return result
}

function pendingPrompt(type: string, payload: Record<string, unknown>): PendingPrompt {
  return {
    kind: type.split('.')[0] as PendingPrompt['kind'],
    payload,
    requestId: text(payload.request_id)
  }
}

export function reduceGatewayEvent(state: ChatState, event: GatewayEvent): ChatState {
  const payload = record(event.payload)
  if (event.session_id && event.session_id !== state.runtimeSessionId) return state

  switch (event.type) {
    case 'session.info': {
      const marker = payload.desktop_contract
      const contractVersion = marker === undefined
        ? state.contractVersion
        : typeof marker === 'number' && Number.isFinite(marker) ? marker : state.contractVersion
      return {
        ...state,
        contractVersion,
        info: payload as unknown as ChatState['info'],
        running: Boolean(payload.running),
        storedSessionId: text(payload.stored_session_id) || state.storedSessionId
      }
    }
    case 'message.start':
      return { ...state, error: null, running: true }
    case 'message.delta':
      return { ...state, messages: updateLastAssistant(state.messages, text(payload.delta ?? payload.text)) }
    case 'thinking.delta':
    case 'reasoning.delta': {
      const messages = updateLastAssistant(state.messages, '', true)
      const last = messages.at(-1)
      if (last) messages[messages.length - 1] = { ...last, reasoning: `${last.reasoning ?? ''}${text(payload.delta ?? payload.text)}` }
      return { ...state, messages }
    }
    case 'message.complete': {
      const messages = updateLastAssistant(state.messages, text(payload.delta), false)
      return { ...state, messages, running: false }
    }
    case 'tool.start':
      return { ...state, tools: upsertTool(state.tools, payload, 'running') }
    case 'tool.progress':
      return { ...state, tools: upsertTool(state.tools, payload, 'progress') }
    case 'tool.generating':
      return { ...state, tools: upsertTool(state.tools, payload, 'generating') }
    case 'tool.complete':
      return { ...state, tools: upsertTool(state.tools, payload, 'complete') }
    case 'clarify.request':
    case 'approval.request':
    case 'sudo.request':
    case 'secret.request':
      return { ...state, pendingPrompt: pendingPrompt(event.type, payload) }
    case 'error':
      return { ...state, error: text(payload.message ?? payload.error) || 'Hermes reported an error.', running: false }
    default:
      // Forward compatibility: unknown gateway events are intentionally inert.
      return state
  }
}
