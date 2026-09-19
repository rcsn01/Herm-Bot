import { describe, expect, it, vi } from 'vitest'

import { createMemoryOAuthAdapter, createProviderOAuthAdapter } from './oauth-sources'
import type { MemoryProviderOAuthStatus, OAuthPollResponse, OAuthStartResponse } from '~/lib/types'
import { MemoryGateway } from '~/test/memory-gateway'

const gateway = new MemoryGateway()

describe('provider OAuth adapter', () => {
  it('maps a PKCE start response to a waiting snapshot', async () => {
    const response: OAuthStartResponse = { auth_url: 'https://auth.example/pkce', expires_in: 300, flow: 'pkce', session_id: 'pkce-1' }
    const settings = { oauthPoll: vi.fn(), oauthStart: vi.fn(async () => response) }
    const source = createProviderOAuthAdapter(settings, gateway, 'provider')

    await expect(source.start(new AbortController().signal)).resolves.toEqual({
      authorizationURL: 'https://auth.example/pkce',
      flowId: 'pkce-1',
      phase: 'waiting'
    })
  })

  it('maps a device-code start response to a waiting snapshot with its code', async () => {
    const response: OAuthStartResponse = {
      expires_in: 300,
      flow: 'device_code',
      poll_interval: 5,
      session_id: 'device-1',
      user_code: 'ABCD-EFGH',
      verification_url: 'https://auth.example/device'
    }
    const settings = { oauthPoll: vi.fn(), oauthStart: vi.fn(async () => response) }
    const source = createProviderOAuthAdapter(settings, gateway, 'provider')

    await expect(source.start(new AbortController().signal)).resolves.toEqual({
      authorizationURL: 'https://auth.example/device',
      flowId: 'device-1',
      phase: 'waiting',
      userCode: 'ABCD-EFGH'
    })
  })

  it.each([
    ['pending', 'waiting'],
    ['approved', 'approved'],
    ['denied', 'denied'],
    ['expired', 'expired'],
    ['error', 'error']
  ] as const)('maps provider poll status %s to %s', async (status, phase) => {
    const response: OAuthPollResponse = { error_message: status === 'error' ? 'Provider rejected authorization.' : null, session_id: 'flow-1', status }
    const settings = { oauthPoll: vi.fn(async () => response), oauthStart: vi.fn() }
    const source = createProviderOAuthAdapter(settings, gateway, 'provider')

    await expect(source.poll({ flowId: 'flow-1', phase: 'waiting' }, new AbortController().signal)).resolves.toEqual({
      flowId: 'flow-1',
      message: status === 'error' ? 'Provider rejected authorization.' : undefined,
      phase
    })
    expect(settings.oauthPoll).toHaveBeenCalledWith('provider', 'flow-1', expect.any(AbortSignal))
  })

  it('rejects a start response without a session or authorization URL', async () => {
    const settings = {
      oauthPoll: vi.fn(),
      oauthStart: vi.fn(async () => ({ auth_url: '', expires_in: 300, flow: 'pkce', session_id: '' } as OAuthStartResponse))
    }
    const source = createProviderOAuthAdapter(settings, gateway, 'provider')

    await expect(source.start(new AbortController().signal)).rejects.toThrow(/invalid provider OAuth flow/i)
  })
})

describe('memory-provider OAuth adapter', () => {
  const status = (state: MemoryProviderOAuthStatus['state'], detail = ''): MemoryProviderOAuthStatus => ({
    auth: 'oauth',
    connected: state === 'connected',
    detail,
    state
  })

  it.each([
    ['connected', 'approved'],
    ['pending', 'waiting'],
    ['error', 'error'],
    ['idle', 'error']
  ] as const)('maps active status %s to %s', async (state, phase) => {
    const settings = {
      memoryOAuthStatus: vi.fn(async () => status(state, state === 'error' ? 'Provider rejected authorization.' : '')),
      startMemoryOAuth: vi.fn(async () => status(state, state === 'error' ? 'Provider rejected authorization.' : ''))
    }
    const source = createMemoryOAuthAdapter(settings, gateway, 'memory')

    await expect(source.start(new AbortController().signal)).resolves.toMatchObject({ phase })
    expect((await source.start(new AbortController().signal)).flowId).toBeUndefined()
    expect((await source.start(new AbortController().signal)).authorizationURL).toBeUndefined()
  })

  it('keeps an active pending status pollable without a handle', async () => {
    const settings = {
      memoryOAuthStatus: vi.fn(async () => status('pending')),
      startMemoryOAuth: vi.fn(async () => status('pending'))
    }
    const source = createMemoryOAuthAdapter(settings, gateway, 'memory')

    await expect(source.poll({ phase: 'waiting' }, new AbortController().signal)).resolves.toEqual({ phase: 'waiting' })
  })

  it('carries memory provider error detail', async () => {
    const settings = {
      memoryOAuthStatus: vi.fn(),
      startMemoryOAuth: vi.fn(async () => status('error', 'Provider rejected authorization.'))
    }
    const source = createMemoryOAuthAdapter(settings, gateway, 'memory')

    await expect(source.start(new AbortController().signal)).resolves.toEqual({ message: 'Provider rejected authorization.', phase: 'error' })
  })
})
