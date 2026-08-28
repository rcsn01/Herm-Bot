import { describe, expect, it } from 'vitest'

import type { ChatState } from '~/lib/types'
import { emptyChatState, reduceGatewayEvent } from '~/state/event-reducer'

describe('reduceGatewayEvent', () => {
  it('reduces streaming text, reasoning, tools, completion, and context info', () => {
    let state: ChatState = { ...emptyChatState(), runtimeSessionId: 'runtime-1' }
    state = reduceGatewayEvent(state, { type: 'session.info', session_id: 'runtime-1', payload: { desktop_contract: 3, stored_session_id: 'durable-1', running: true } })
    state = reduceGatewayEvent(state, { type: 'message.delta', session_id: 'runtime-1', payload: { delta: 'Hello' } })
    state = reduceGatewayEvent(state, { type: 'reasoning.delta', session_id: 'runtime-1', payload: { delta: 'Think' } })
    state = reduceGatewayEvent(state, { type: 'tool.start', session_id: 'runtime-1', payload: { id: 'tool-1', name: 'terminal' } })
    state = reduceGatewayEvent(state, { type: 'tool.complete', session_id: 'runtime-1', payload: { id: 'tool-1', name: 'terminal', output: 'ok' } })
    state = reduceGatewayEvent(state, { type: 'message.complete', session_id: 'runtime-1', payload: {} })

    expect(state.contractVersion).toBe(3)
    expect(state.storedSessionId).toBe('durable-1')
    expect(state.messages[0]).toMatchObject({ content: 'Hello', reasoning: 'Think', streaming: false })
    expect(state.tools[0]).toMatchObject({ detail: 'ok', status: 'complete' })
    expect(state.running).toBe(false)
  })

  it('preserves legacy and validated contract state when session events omit or corrupt the marker', () => {
    const legacy = { ...emptyChatState(), contractVersion: null, runtimeSessionId: 'legacy' }
    expect(reduceGatewayEvent(legacy, { type: 'session.info', session_id: 'legacy', payload: { running: true } }).contractVersion).toBeNull()

    const current = { ...emptyChatState(), contractVersion: 6, runtimeSessionId: 'current' }
    expect(reduceGatewayEvent(current, { type: 'session.info', session_id: 'current', payload: { desktop_contract: null } }).contractVersion).toBe(6)
  })

  it.each(['clarify', 'approval', 'sudo', 'secret'] as const)('maps %s requests without persisting answers', kind => {
    const state = reduceGatewayEvent(emptyChatState(), { type: `${kind}.request`, payload: { request_id: 'request-1', question: 'value?' } })
    expect(state.pendingPrompt).toMatchObject({ kind, requestId: 'request-1' })
    expect(JSON.stringify(state)).not.toContain('answer')
  })

  it('ignores events for another runtime session and unknown future events', () => {
    const state = { ...emptyChatState(), runtimeSessionId: 'active' }
    expect(reduceGatewayEvent(state, { type: 'message.delta', session_id: 'other', payload: { delta: 'leak' } })).toBe(state)
    expect(reduceGatewayEvent(state, { type: 'gateway.future-event', payload: { anything: true } })).toBe(state)
  })
})
