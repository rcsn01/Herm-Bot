import { describe, expect, it } from 'vitest'

import { parsePushPayload } from './push-payload'

describe('Web Push payload policy', () => {
  it('accepts same-origin session links', () => {
    expect(parsePushPayload({
      body: 'Finished',
      title: 'Hermes',
      url: 'https://mobile.example/session/a%2Fb?profile=work'
    }, 'https://mobile.example')).toMatchObject({
      body: 'Finished',
      title: 'Hermes',
      url: '/session/a%2Fb?profile=work'
    })
  })

  it('does not open a cross-origin URL supplied by a notification', () => {
    expect(parsePushPayload({ url: 'https://attacker.example/login' }, 'https://mobile.example').url).toBe('/')
  })

  it('uses bounded safe defaults for malformed payloads', () => {
    const parsed = parsePushPayload({ body: 'x'.repeat(800), tag: 3 }, 'https://mobile.example')
    expect(parsed.body).toHaveLength(500)
    expect(parsed.tag).toBe('hermes-turn-complete')
    expect(parsed.title).toBe('Hermes')
  })
})
