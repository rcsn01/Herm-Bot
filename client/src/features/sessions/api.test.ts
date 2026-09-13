import { describe, expect, it } from 'vitest'

import { createSessionsApi, humanSessions } from './api'
import { createGatewayApi } from '~/gateway/gateway-api'
import { MemoryGateway } from '~/test/memory-gateway'

describe('humanSessions', () => {
  it('drops automation sessions while keeping every human surface', () => {
    const sessions = [
      { id: 'cron-1', message_count: 3, preview: '', source: 'cron', started_at: 400, title: 'Nightly digest' },
      { id: 'tool-1', message_count: 1, preview: '', source: 'tool', started_at: 350, title: 'Sub-agent run' },
      { id: 'kanban-1', message_count: 1, preview: '', source: 'kanban', started_at: 320, title: 'Worker row' },
      { id: 'cron-2', message_count: 2, preview: '', source: ' Cron ', started_at: 310, title: 'Cushioned cron' },
      { id: 'human-1', message_count: 4, preview: '', source: 'ios', started_at: 300, title: 'Planning session' },
      { id: 'human-2', message_count: 2, preview: '', source: 'web', started_at: 200, title: 'Release notes' },
      { id: 'human-3', message_count: 1, preview: '', source: '', started_at: 100, title: 'Legacy session' }
    ]

    expect(humanSessions(sessions).map(session => session.id)).toEqual(['human-1', 'human-2', 'human-3'])
  })
})

describe('sessionsApi', () => {
  it('renames with the profile in the PATCH body and the query', async () => {
    const gateway = new MemoryGateway().handle('/api/sessions/s1?profile=client+work%2Fios', value => value)
    const sessions = createSessionsApi(createGatewayApi(gateway, 'client work/ios'))

    await sessions.rename('s1', 'Renamed')

    expect(gateway.calls).toHaveLength(1)
    expect(gateway.calls[0]).toMatchObject({ kind: 'request', method: 'PATCH' })
    expect(gateway.calls[0].value).toMatchObject({
      body: { profile: 'client work/ios', title: 'Renamed' },
      method: 'PATCH',
      path: '/api/sessions/s1?profile=client+work%2Fios'
    })
  })

  it('archives with the profile in the PATCH body and the query', async () => {
    const gateway = new MemoryGateway().handle('/api/sessions/s1?profile=client+work%2Fios', value => value)
    const sessions = createSessionsApi(createGatewayApi(gateway, 'client work/ios'))

    await sessions.archive('s1')

    expect(gateway.calls[0].value).toMatchObject({
      body: { archived: true, profile: 'client work/ios' },
      method: 'PATCH',
      path: '/api/sessions/s1?profile=client+work%2Fios'
    })
  })

  it('restores with archived:false and no profile in the body', async () => {
    const gateway = new MemoryGateway().handle('/api/sessions/s1?profile=client+work%2Fios', value => value)
    const sessions = createSessionsApi(createGatewayApi(gateway, 'client work/ios'))

    await sessions.restore('s1')

    expect(gateway.calls[0].value).toMatchObject({
      body: { archived: false },
      method: 'PATCH',
      path: '/api/sessions/s1?profile=client+work%2Fios'
    })
  })

  it('deletes with no body', async () => {
    const gateway = new MemoryGateway().handle('/api/sessions/s1?profile=client+work%2Fios', value => value)
    const sessions = createSessionsApi(createGatewayApi(gateway, 'client work/ios'))

    await sessions.remove('s1')

    expect(gateway.calls[0].value).toMatchObject({
      method: 'DELETE',
      path: '/api/sessions/s1?profile=client+work%2Fios'
    })
    expect((gateway.calls[0].value as { body?: unknown }).body).toBeUndefined()
  })

  it('lists through the session.list RPC with the profile in the params', async () => {
    const gateway = new MemoryGateway().handle('session.list', params => params)
    const sessions = createSessionsApi(createGatewayApi(gateway, null))

    await expect(sessions.list(30)).resolves.toEqual({ include_hidden: true, limit: 30, profile: 'default' })

    const named = createSessionsApi(createGatewayApi(gateway, 'client work/ios'))
    await named.list(30)
    expect(gateway.calls.filter(call => call.kind === 'rpc').map(call => call.value)).toEqual([
      { include_hidden: true, limit: 30, profile: 'default' },
      { include_hidden: true, limit: 30, profile: 'client work/ios' }
    ])
  })

  it('lists bot-owned hidden sessions so the desktop conversations are visible', async () => {
    const gateway = new MemoryGateway().handle('session.list', params => ({
      sessions: (params as { include_hidden?: boolean }).include_hidden
        ? [{ id: 'hidden-bot-chat', message_count: 2, preview: '', source: 'desktop', started_at: 1, title: 'Hey, tell me about yourself!' }]
        : []
    }))
    const sessions = createSessionsApi(createGatewayApi(gateway, 'codex'))

    await expect(sessions.list(30)).resolves.toEqual({
      sessions: [expect.objectContaining({ id: 'hidden-bot-chat' })]
    })
  })

  it('URL-encodes session ids in the route path', async () => {
    const gateway = new MemoryGateway().handle('/api/sessions/session%2F1?profile=client+work%2Fios', value => value)
    const sessions = createSessionsApi(createGatewayApi(gateway, 'client work/ios'))

    await sessions.remove('session/1')

    expect(gateway.calls[0].value).toMatchObject({
      method: 'DELETE',
      path: '/api/sessions/session%2F1?profile=client+work%2Fios'
    })
  })

  it('addresses the default profile explicitly on every REST route', async () => {
    const gateway = new MemoryGateway()
      .handle('/api/sessions/s1?profile=default', value => value)
      .handle('session.list', () => ({ sessions: [] }))
    const sessions = createSessionsApi(createGatewayApi(gateway, null))

    await sessions.rename('s1', 'Renamed')
    await sessions.archive('s1')
    await sessions.restore('s1')
    await sessions.remove('s1')

    expect(gateway.calls.filter(call => call.kind === 'request').map(call => call.value)).toEqual([
      expect.objectContaining({ body: { profile: 'default', title: 'Renamed' }, method: 'PATCH', path: '/api/sessions/s1?profile=default' }),
      expect.objectContaining({ body: { archived: true, profile: 'default' }, method: 'PATCH', path: '/api/sessions/s1?profile=default' }),
      expect.objectContaining({ body: { archived: false }, method: 'PATCH', path: '/api/sessions/s1?profile=default' }),
      expect.objectContaining({ method: 'DELETE', path: '/api/sessions/s1?profile=default' })
    ])
  })
})