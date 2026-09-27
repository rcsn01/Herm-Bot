import { describe, expect, it } from 'vitest'

import {
  acquireGroupSessionProvenance,
  groupPromptBelongsToConnection,
  groupSessionIdForConnection,
  groupStrandedMarkerForConnection,
  normalizeGroupSessionProvenance,
  rekeyGroupSessionProvenance,
  retainGroupPromptsForConnection,
  retainGroupSessionProvenanceForConnection,
  stampGroupPromptConnection
} from './group-session-provenance'

describe('Group session provenance policy', () => {
  it('returns a stored id only for the exact tagged connection and member', () => {
    const tagged = {
      sessionConnectionKey: 'https://gateway-a.test',
      sessions: { ada: 'stored-1' },
      stranded: {}
    }
    expect(groupSessionIdForConnection(tagged, 'https://gateway-a.test', 'ada')).toBe('stored-1')
    expect(groupSessionIdForConnection(tagged, 'https://gateway-b.test', 'ada')).toBeUndefined()
    expect(groupSessionIdForConnection({ sessions: { ada: 'orphan' } }, 'https://gateway-a.test', 'ada')).toBeUndefined()
    expect(groupSessionIdForConnection(tagged, 'https://gateway-a.test', 'scout')).toBeUndefined()
  })

  it('records acquisitions atomically, preserving only same-connection entries', () => {
    const previous = {
      sessionConnectionKey: 'https://gateway-a.test',
      sessions: { ada: 'old-ada', scout: 'scout-id' },
      stranded: { ada: 0 }
    }
    expect(acquireGroupSessionProvenance(previous, 'https://gateway-a.test', 'ada', 'new-ada')).toEqual({
      sessionConnectionKey: 'https://gateway-a.test',
      sessions: { ada: 'new-ada', scout: 'scout-id' },
      stranded: { ada: 0 }
    })
    expect(acquireGroupSessionProvenance(previous, 'https://gateway-b.test', 'ada', 'gateway-b-id')).toEqual({
      sessionConnectionKey: 'https://gateway-b.test',
      sessions: { ada: 'gateway-b-id' }
    })
    expect(acquireGroupSessionProvenance(previous, 'https://gateway-b.test', 'ada')).toEqual({
      sessionConnectionKey: 'https://gateway-b.test'
    })
  })

  it('stamps and filters prompt ownership by exact non-empty connection key', () => {
    const stamped = stampGroupPromptConnection({ requestId: 'q1' }, 'https://gateway-a.test')
    expect(stamped).toEqual({ requestId: 'q1', connectionKey: 'https://gateway-a.test' })
    expect(groupPromptBelongsToConnection(stamped, 'https://gateway-a.test')).toBe(true)
    expect(groupPromptBelongsToConnection(stamped, 'https://gateway-b.test')).toBe(false)
    expect(groupPromptBelongsToConnection({}, 'https://gateway-a.test')).toBe(false)
    expect(groupPromptBelongsToConnection({ connectionKey: '' }, '')).toBe(false)

    const prompts = {
      same: stamped,
      foreign: { connectionKey: 'https://gateway-b.test', requestId: 'q2' },
      untagged: { requestId: 'q3' }
    }
    expect(retainGroupPromptsForConnection(prompts, 'https://gateway-a.test')).toEqual({ same: stamped })
    const matching = { same: stamped }
    expect(retainGroupPromptsForConnection(matching, 'https://gateway-a.test')).toBe(matching)
  })

  it('scopes stranded markers and atomically clears foreign or untagged state', () => {
    const matching = {
      sessionConnectionKey: 'https://gateway-a.test',
      sessions: { ada: 'stored-a' },
      stranded: { ada: 0 },
      log: ['shared']
    }
    const foreign = {
      sessionConnectionKey: 'https://gateway-b.test',
      sessions: { ada: 'stored-b' },
      stranded: { ada: { before: 2, thread: 't2' } },
      log: ['shared']
    }
    const untagged = { sessions: { ada: 'orphan' }, stranded: { ada: 0 }, log: ['shared'] }
    const empty = { sessions: {}, stranded: {}, log: ['shared'] }

    expect(groupStrandedMarkerForConnection(matching, 'https://gateway-a.test', 'ada')).toBe(0)
    expect(groupStrandedMarkerForConnection(matching, 'https://gateway-b.test', 'ada')).toBeUndefined()
    expect(retainGroupSessionProvenanceForConnection(matching, 'https://gateway-a.test')).toBe(matching)
    expect(retainGroupSessionProvenanceForConnection(foreign, 'https://gateway-a.test')).toEqual({ log: ['shared'] })
    expect(retainGroupSessionProvenanceForConnection(untagged, 'https://gateway-a.test')).toEqual({ log: ['shared'] })
    expect(retainGroupSessionProvenanceForConnection(empty, 'https://gateway-a.test')).toBe(empty)
  })

  it('re-keys valid local provenance without mutating it or accepting unowned maps', () => {
    const local = {
      sessionConnectionKey: 'https://gateway-a.test',
      sessions: { ada: 'stored-a', 'gw-2::ada': 'qualified' },
      stranded: { ada: 0 },
      members: [{ name: 'ada', connectionId: 'gw-2' }],
      log: ['shared']
    }
    expect(rekeyGroupSessionProvenance(local, local.members)).toEqual({
      ...local,
      sessions: { ada: 'stored-a', 'gw-2::ada': 'qualified' },
      stranded: { 'gw-2::ada': 0 }
    })
    expect(local.sessions).toEqual({ ada: 'stored-a', 'gw-2::ada': 'qualified' })
    expect(rekeyGroupSessionProvenance({ sessions: { ada: 'orphan' }, log: ['shared'] }, [
      { name: 'ada', connectionId: 'gw-2' }
    ])).toEqual({ log: ['shared'] })
  })

  it('rejects the whole trio when any persisted provenance field is malformed', () => {
    const validTag = 'https://gateway-a.test'
    const invalid: unknown[] = [
      null,
      {},
      { sessionConnectionKey: '' },
      { sessionConnectionKey: 7 },
      { sessionConnectionKey: validTag, sessions: [] },
      { sessionConnectionKey: validTag, sessions: null },
      { sessionConnectionKey: validTag, sessions: { ada: '' } },
      { sessionConnectionKey: validTag, sessions: { ada: 7 } },
      { sessionConnectionKey: validTag, sessions: { '': 'stored' } },
      { sessionConnectionKey: validTag, stranded: [] },
      { sessionConnectionKey: validTag, stranded: { ada: null } },
      { sessionConnectionKey: validTag, stranded: { ada: -1 } },
      { sessionConnectionKey: validTag, stranded: { ada: Number.POSITIVE_INFINITY } },
      { sessionConnectionKey: validTag, stranded: { ada: { before: -1, thread: 't1' } } },
      { sessionConnectionKey: validTag, stranded: { ada: { before: 0, thread: '' } } }
    ]
    for (const value of invalid) expect(normalizeGroupSessionProvenance(value)).toBeNull()
  })

  it('normalizes a tagged trio, including empty maps and cursor zero', () => {
    expect(normalizeGroupSessionProvenance({
      sessionConnectionKey: 'https://gateway-a.test',
      sessions: { 'gw-1::ada': 'stored-1' },
      stranded: { 'gw-1::ada': 0, scout: { before: 2, thread: 't1' } }
    })).toEqual({
      sessionConnectionKey: 'https://gateway-a.test',
      sessions: { 'gw-1::ada': 'stored-1' },
      stranded: { 'gw-1::ada': 0, scout: { before: 2, thread: 't1' } }
    })

    expect(normalizeGroupSessionProvenance({ sessionConnectionKey: 'https://gateway-a.test' })).toEqual({
      sessionConnectionKey: 'https://gateway-a.test',
      sessions: {},
      stranded: {}
    })
  })
})
