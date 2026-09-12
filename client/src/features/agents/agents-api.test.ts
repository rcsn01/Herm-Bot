import { describe, expect, it } from 'vitest'

import { mergeAgentRoster, parseAgentRoster } from '~/features/agents/agents-api'

describe('agent roster parsing', () => {
  it('normalizes rich profiles.list items from an array body', () => {
    expect(parseAgentRoster([
      { name: 'work', preview: 'One new Fujitsu stream', last_active: 1_700_000_000, session_id: 'bot-chat' },
      'default',
      { title: 'Searcher', last_active: '2026-09-10T09:30:00Z' },
      null,
      7
    ])).toEqual([
      { isDefault: false, name: 'work', preview: 'One new Fujitsu stream', sessionId: 'bot-chat', startedAt: 1_700_000_000, title: undefined },
      { isDefault: true, name: 'default', preview: undefined, sessionId: undefined, startedAt: undefined, title: undefined },
      { isDefault: false, name: 'Searcher', preview: undefined, sessionId: undefined, startedAt: Math.floor(Date.parse('2026-09-10T09:30:00Z') / 1000), title: 'Searcher' }
    ])
  })

  it('unwraps a profiles object body and drops unusable entries', () => {
    expect(parseAgentRoster({ profiles: [{ name: 'work', preview: 'Daily digest' }, { preview: 'no name' }, 42] })).toEqual([
      { isDefault: false, name: 'work', preview: 'Daily digest', sessionId: undefined, startedAt: undefined, title: undefined }
    ])
    expect(parseAgentRoster({})).toEqual([])
    expect(parseAgentRoster(null)).toEqual([])
  })

  it('normalizes millisecond and ISO last-active stamps into epoch seconds', () => {
    const entries = parseAgentRoster([{ name: 'a', last_active: 1_700_000_000_000 }, { name: 'b', last_active: '2026-09-10T09:30:00Z' }])
    expect(entries[0]?.startedAt).toBe(1_700_000_000)
    expect(entries[1]?.startedAt).toBe(Math.floor(Date.parse('2026-09-10T09:30:00Z') / 1000))
  })
})

describe('agent roster merge', () => {
  it('keeps status order, overlays enrichment, and appends extras', () => {
    const merged = mergeAgentRoster(
      [{ name: 'default', is_default: true }, { name: 'work' }],
      [
        { isDefault: false, name: 'work', preview: 'Daily digest', startedAt: 1_700_000_000 },
        { isDefault: true, name: 'default' },
        { isDefault: false, name: 'extra' }
      ]
    )

    expect(merged).toEqual([
      { isDefault: true, name: 'default', preview: undefined, sessionId: undefined, startedAt: undefined, title: undefined },
      { isDefault: false, name: 'work', preview: 'Daily digest', sessionId: undefined, startedAt: 1_700_000_000, title: undefined },
      { isDefault: false, name: 'extra', preview: undefined, sessionId: undefined, startedAt: undefined, title: undefined }
    ])
  })

  it('falls back to bare status names without enrichment', () => {
    expect(mergeAgentRoster(['default', { name: 'work' }], [])).toEqual([
      { isDefault: true, name: 'default', preview: undefined, sessionId: undefined, startedAt: undefined, title: undefined },
      { isDefault: false, name: 'work', preview: undefined, sessionId: undefined, startedAt: undefined, title: undefined }
    ])
    expect(mergeAgentRoster(undefined, [{ isDefault: false, name: 'work' }])).toEqual([
      { isDefault: false, name: 'work', preview: undefined, sessionId: undefined, startedAt: undefined, title: undefined }
    ])
  })
})