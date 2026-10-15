import { describe, expect, it } from 'vitest'

import { parsePushPayload } from './push-payload'

describe('Web Push payload policy', () => {
  it('accepts same-origin session links', () => {
    expect(parsePushPayload({
      body: 'Finished',
      title: 'Hermes',
      url: `https://mobile.example/session/a%2Fb?profile=work&push=1&push_owner=${'a'.repeat(64)}`
    }, 'https://mobile.example')).toMatchObject({
      body: 'Finished',
      title: 'Hermes',
      url: `/session/a%2Fb?profile=work&push=1&push_owner=${'a'.repeat(64)}`
    })
  })

  it('preserves an agent response preview supplied by the relay', () => {
    const body = `${'a'.repeat(498)}…`
    expect(parsePushPayload({ body }, 'https://mobile.example').body).toBe(body)
  })

  it('does not open a cross-origin URL supplied by a notification', () => {
    expect(parsePushPayload({ url: 'https://attacker.example/login' }, 'https://mobile.example').url).toBe('/')
  })

  it('does not navigate legacy unowned notifications or arbitrary same-origin routes', () => {
    for (const url of ['/session/abc?profile=work', '/auth/logout', '/settings']) expect(parsePushPayload({ url }, 'https://mobile.example').url).toBe('/')
  })

  it('uses bounded safe defaults for malformed payloads', () => {
    const parsed = parsePushPayload({ body: 'x'.repeat(800), tag: 3 }, 'https://mobile.example')
    expect(parsed.body).toHaveLength(500)
    expect(parsed.tag).toBe('hermes-turn-complete')
    expect(parsed.title).toBe('Hermes')
  })
})
