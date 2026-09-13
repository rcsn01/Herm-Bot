import { describe, expect, it } from 'vitest'

import { mergeAgentRoster, parseAgentRoster } from '~/features/agents/agents-api'

describe('agent roster parsing', () => {
  it('normalizes rich profiles.list items from an array body', () => {
    expect(parseAgentRoster([
      { name: 'work', display_name: '  Ops Bot  ', preview: 'One new Fujitsu stream', last_active: 1_700_000_000, session_id: 'bot-chat' },
      'default',
      { title: 'Searcher', last_active: '2026-09-10T09:30:00Z' },
      null,
      7
    ])).toEqual([
      { displayName: 'Ops Bot', isDefault: false, name: 'work', preview: 'One new Fujitsu stream', sessionId: 'bot-chat', startedAt: 1_700_000_000, title: undefined },
      { displayName: undefined, isDefault: true, name: 'default', preview: undefined, sessionId: undefined, startedAt: undefined, title: undefined },
      { displayName: undefined, isDefault: false, name: 'Searcher', preview: undefined, sessionId: undefined, startedAt: Math.floor(Date.parse('2026-09-10T09:30:00Z') / 1000), title: undefined }
    ])
  })

  it('reads the Bot Mode meta from ui_meta and never mistakes the session title for the bot name', () => {
    const entries = parseAgentRoster([
      {
        // The wire's top-level title is the latest human session's title
        // (tui_gateway/methods_profiles.py roster enrichment) — not the bot's name.
        name: 'default',
        title: 'My weekend plans',
        ui_meta: {
          'hermes-bots': {
            color: '#8b5cf6',
            custom: true,
            image: 'data:image/png;base64,AAA',
            imageKind: 'photo',
            shape: 'blobatar:7:cat',
            title: '  Hermes  '
          }
        }
      },
      { name: 'scout', ui_meta: { unrelated: true } },
      { name: 'forge', ui_meta: { 'hermes-bots': { title: '   ' } } }
    ])

    expect(entries[0]).toMatchObject({
      meta: { color: '#8b5cf6', custom: true, image: 'data:image/png;base64,AAA', imageKind: 'photo', shape: 'blobatar:7:cat', title: 'Hermes' },
      title: 'Hermes'
    })
    expect(entries[1]?.meta).toBeUndefined()
    expect(entries[1]?.title).toBeUndefined()
    expect(entries[2]?.meta).toBeUndefined()
    expect(entries[2]?.title).toBeUndefined()
  })

  it('unwraps a profiles object body and drops unusable entries', () => {
    expect(parseAgentRoster({ profiles: [{ name: 'work', preview: 'Daily digest' }, { preview: 'no name' }, 42] })).toEqual([
      { isDefault: false, name: 'work', preview: 'Daily digest', sessionId: undefined, startedAt: undefined, title: undefined }
    ])
    expect(parseAgentRoster({})).toEqual([])
    expect(parseAgentRoster(null)).toEqual([])
  })

  it('keeps usable avatar references and drops unusable ones', () => {
    const entries = parseAgentRoster([
      { name: 'a', avatar: 'data:image/png;base64,AAA' },
      { name: 'b', avatar: 'https://gateway.example/avatar.png' },
      { name: 'c', avatar: 'javascript:alert(1)' },
      { name: 'd', avatar: 42 }
    ])

    expect(entries[0]?.avatar).toBe('data:image/png;base64,AAA')
    expect(entries[1]?.avatar).toBe('https://gateway.example/avatar.png')
    expect(entries[2]?.avatar).toBeUndefined()
    expect(entries[3]?.avatar).toBeUndefined()
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