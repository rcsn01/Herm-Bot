import { describe, expect, it } from 'vitest'

import { displayNameFor } from './agent-labels'

describe('bot display names (desktop labels port)', () => {
  it('presents the primary default profile as Hermes', () => {
    expect(displayNameFor({ name: 'default' })).toBe('Hermes')
    expect(displayNameFor({ name: 'Default' })).toBe('Hermes')
  })

  it('reads slug names the way the desktop does', () => {
    expect(displayNameFor({ name: 'codex' })).toBe('Codex')
    expect(displayNameFor({ name: 'my-bot' })).toBe('My Bot')
    expect(displayNameFor({ name: 'food_bot' })).toBe('Food Bot')
    expect(displayNameFor({ name: 'work' })).toBe('Work')
  })

  it('keeps an already-cased name readable', () => {
    expect(displayNameFor({ name: 'Searcher' })).toBe('Searcher')
  })

  it('uses the CLI display_name from the roster row when present', () => {
    expect(displayNameFor({ displayName: '  Ops Bot  ', name: 'default' })).toBe('Ops Bot')
    expect(displayNameFor({ displayName: 'Renamed', name: 'codex' })).toBe('Renamed')
  })

  it('uses a stored bot title before the slug', () => {
    expect(displayNameFor({ name: 'default', title: 'Ops' })).toBe('Ops')
    expect(displayNameFor({ name: 'codex', title: 'Codex CLI' })).toBe('Codex CLI')
  })
})