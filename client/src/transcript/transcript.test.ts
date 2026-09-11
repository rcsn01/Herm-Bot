import { describe, expect, it } from 'vitest'

import type { SessionMessage } from '~/compat/hermes-types'
import { createTranscript, updateTranscript, type TranscriptContext, type TranscriptSnapshot } from '~/transcript/transcript'

const ordinary: TranscriptContext = { source: null, storedSessionId: 'stored-1' }
const cron: TranscriptContext = { source: 'cron', storedSessionId: 'scheduled-1' }
const rows = (values: unknown[]) => values as SessionMessage[]
const contents = (transcript: TranscriptSnapshot) => transcript.entries.map(entry => entry.content)

describe('Transcript row projection', () => {
  it('normalizes compatibility fields without conflating durable and render identity', () => {
    const transcript = createTranscript(ordinary, rows([
      { role: 'user', content: 'ignored', display_content: 'visible', row_id: 41, text: 'fallback' },
      { role: 'assistant', content: null, reasoning_content: 'carefully', text: 'answer' },
      { role: 'tool', content: null, context: 'terminal output', id: 43 },
      { role: 'assistant', content: { type: 'image' }, text: 'not selected' }
    ]))

    expect(transcript.entries).toEqual([
      { author: 'user', content: 'visible', editTarget: { rowId: 41, userOrdinal: 0 }, id: 'history-row-41', kind: 'message', reasoning: undefined, rowId: 41, streaming: false },
      { author: 'assistant', content: 'answer', id: 'history-1', kind: 'message', reasoning: 'carefully', streaming: false },
      { content: 'terminal output', id: 'history-row-43', kind: 'tool-output', rowId: 43 }
    ])
  })

  it('preserves exact precedence when selected compatibility values are malformed', () => {
    const transcript = createTranscript(ordinary, rows([
      { role: 'user', display_content: null, content: 'content', text: 'text' },
      { role: 'user', display_content: { malformed: true }, content: 'content' },
      { role: 'tool', content: { malformed: true }, text: 'text', context: 'context', name: 'name' },
      { role: 'assistant', content: 'answer', reasoning: '', reasoning_content: 'fallback' },
      { role: 'assistant', content: 'fallback reasoning', reasoning: null, reasoning_content: 'compatibility' },
      { role: 'user', content: 'row', row_id: 'bad', id: 9 },
      { role: 'user', content: 'null row id', row_id: null, id: 10 }
    ]))

    expect(contents(transcript)).toEqual(['', '', '', 'answer', 'fallback reasoning', 'row', 'null row id'])
    expect(transcript.entries[2]).toMatchObject({ kind: 'tool-output' })
    expect(transcript.entries[3]).toMatchObject({ reasoning: '' })
    expect(transcript.entries[4]).toMatchObject({ reasoning: 'compatibility' })
    expect(transcript.entries[5]).toMatchObject({ id: 'history-5' })
    expect(transcript.entries[5]).not.toHaveProperty('rowId')
    expect(transcript.entries[6]).toMatchObject({ id: 'history-row-10', rowId: 10 })
  })

  it('ignores malformed rows, hides hidden rows, and uses the raw input index for fallback IDs', () => {
    const transcript = createTranscript(ordinary, rows([
      null,
      'bad',
      { role: 'user', content: 'hidden', display_kind: 'hidden' },
      { role: 'future', content: 'unknown role' },
      { role: 'assistant', content: '   ', reasoning: '\n' },
      { role: 'assistant', content: '', reasoning: 'thought' }
    ]))

    expect(transcript.entries).toEqual([
      { author: 'assistant', content: 'unknown role', id: 'history-3', kind: 'message', reasoning: undefined, streaming: false },
      { author: 'assistant', content: '', id: 'history-5', kind: 'message', reasoning: 'thought', streaming: false }
    ])
  })

  it.each([
    { rowId: 0, id: 'history-row-0', editable: false },
    { rowId: -3, id: 'history-row--3', editable: false },
    { rowId: 7, id: 'history-row-7', editable: true }
  ])('preserves integer row identity for $rowId', ({ rowId, id, editable }) => {
    const [entry] = createTranscript(ordinary, [{ role: 'user', content: 'row', row_id: rowId }]).entries
    expect(entry.id).toBe(id)
    expect('editTarget' in entry && Boolean(entry.editTarget)).toBe(editable)
  })

  it.each([1.2, Number.NaN, '7'])('rejects non-integer row identity %j', rowId => {
    const [entry] = createTranscript(ordinary, rows([{ role: 'user', content: 'row', row_id: rowId }])).entries
    expect(entry).toMatchObject({ id: 'history-0' })
    expect(entry).not.toHaveProperty('rowId')
  })
})

describe('Transcript semantic classification', () => {
  it('uses text, context, and name tool fallbacks only under nullish rules', () => {
    const transcript = createTranscript(ordinary, rows([
      { role: 'tool', content: null, text: 'text', context: 'context', name: 'name' },
      { role: 'tool', content: null, text: null, context: 'context', name: 'name' },
      { role: 'tool', content: null, text: null, context: null, name: 'name' }
    ]))
    expect(contents(transcript)).toEqual(['text', 'context', 'name'])
  })

  it('projects known, inferred, unknown, empty, and hidden display kinds with current precedence', () => {
    const transcript = createTranscript(ordinary, rows([
      { role: 'user', content: 'payload', display_kind: 'model_switch', row_id: 1 },
      { role: 'assistant', content: 'payload', display_kind: 'auto_continue', row_id: 2 },
      { role: 'tool', content: 'payload', display_kind: 'personality_switch', row_id: 3 },
      { role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_old]\nA background fan-out of 3 subagent(s) finished.', row_id: 4 },
      { role: 'user', content: 'future payload', display_kind: 'future_kind', row_id: 5, reasoning: 'why' },
      { role: 'tool', content: 'tool payload', display_kind: 'future_kind', row_id: 6 },
      { role: 'user', content: 'ordinary', display_kind: '', row_id: 7 },
      { role: 'user', content: 'hidden', display_kind: 'hidden', row_id: 8 }
    ]))

    expect(transcript.entries).toEqual([
      { activityKind: 'model_switch', author: 'system', content: 'model changed', id: 'history-row-1', kind: 'activity', reasoning: undefined, rowId: 1, streaming: false },
      { activityKind: 'auto_continue', author: 'system', content: 'resumed interrupted turn', id: 'history-row-2', kind: 'activity', reasoning: undefined, rowId: 2, streaming: false },
      { activityKind: 'personality_switch', author: 'system', content: 'personality changed', id: 'history-row-3', kind: 'activity', reasoning: undefined, rowId: 3, streaming: false },
      { activityKind: 'async_delegation_complete', author: 'system', content: '3 background agents finished', id: 'history-row-4', kind: 'activity', reasoning: undefined, rowId: 4, streaming: false },
      { activityKind: 'future_kind', author: 'user', content: 'future payload', editTarget: { rowId: 5, userOrdinal: 0 }, id: 'history-row-5', kind: 'activity', reasoning: 'why', rowId: 5, streaming: false },
      { content: 'tool payload', id: 'history-row-6', kind: 'tool-output', rowId: 6 },
      { author: 'user', content: 'ordinary', editTarget: { rowId: 7, userOrdinal: 1 }, id: 'history-row-7', kind: 'message', reasoning: undefined, rowId: 7, streaming: false }
    ])
  })

  it('infers singular and generic legacy async activity text', () => {
    const transcript = createTranscript(ordinary, rows([
      { role: 'user', content: '[ASYNC DELEGATION COMPLETE — deleg_one]\nA background subagent finished.' },
      { role: 'user', content: 'unrecognized', display_kind: 'async_delegation_complete' }
    ]))
    expect(contents(transcript)).toEqual(['1 background agent finished', 'background agent work finished'])
  })

  it.each([
    [{ task_count: 1 }, '1 background agent finished'],
    ['{"task_count":2}', '2 background agents finished'],
    ['bad json', '1 background agent finished'],
    [{ task_count: -1 }, '-1 background agents finished'],
    [{ task_count: 1.5 }, '1.5 background agents finished']
  ])('formats async metadata %j without changing numeric compatibility', (metadata, expected) => {
    const [entry] = createTranscript(ordinary, rows([{
      role: 'user', content: '[ASYNC DELEGATION COMPLETE — deleg_one]\nresult',
      display_kind: 'async_delegation_complete', display_metadata: metadata
    }])).entries
    expect(entry.content).toBe(expected)
  })

  it('classifies only the first loaded effective user as cron instructions', () => {
    const marker = '[IMPORTANT: You are running as a scheduled cron job. DELIVERY: report.]'
    const transcript = createTranscript(cron, rows([
      { role: 'system', content: 'system' },
      { role: 'user', content: marker, row_id: 10 },
      { role: 'user', content: marker, row_id: 11 },
      { role: 'user', content: 'later prompt', row_id: 12 }
    ]))

    expect(transcript.entries.map(entry => entry.kind)).toEqual(['message', 'cron-instructions', 'message', 'message'])
    expect(transcript.entries[1]).not.toHaveProperty('editTarget')
    expect(transcript.entries[2]).toMatchObject({ editTarget: { rowId: 11, userOrdinal: 1 } })
    expect(transcript.entries[3]).toMatchObject({ editTarget: { rowId: 12, userOrdinal: 2 } })
  })

  it('does not classify marker variants or later pasted markers', () => {
    const marker = '[IMPORTANT: You are running as a scheduled cron job.'
    for (const input of [
      [{ role: 'user', content: ` ${marker}` }],
      [{ role: 'user', content: 'first' }, { role: 'user', content: marker }],
      [{ role: 'assistant', content: marker }, { role: 'user', content: 'first' }]
    ]) {
      expect(createTranscript(cron, rows(input)).entries.every(entry => entry.kind !== 'cron-instructions')).toBe(true)
    }
    expect(createTranscript(ordinary, rows([{ role: 'user', content: marker }])).entries[0].kind).toBe('message')
  })

  it('reclassifies cron provenance and restores the original kind when an earlier user is prepended', () => {
    const marker = '[IMPORTANT: You are running as a scheduled cron job.'
    let transcript = createTranscript({ source: null, storedSessionId: 'scheduled-1' }, rows([
      { role: 'user', content: marker, display_kind: 'future_kind', reasoning: 'reason', row_id: 10 }
    ]))
    expect(transcript.entries[0].kind).toBe('activity')

    transcript = updateTranscript(transcript, { kind: 'set-context', context: cron })
    expect(transcript.entries[0].kind).toBe('cron-instructions')

    transcript = updateTranscript(transcript, {
      kind: 'prepend-history', fallbackOffset: 80,
      rows: [{ role: 'user', content: 'earlier', row_id: 9 }]
    })
    expect(transcript.entries[1]).toMatchObject({ activityKind: 'future_kind', kind: 'activity', reasoning: 'reason' })
  })
})

describe('Transcript live updates', () => {
  it('creates and appends assistant text and reasoning through gateway changes', () => {
    let transcript = createTranscript(ordinary)
    transcript = updateTranscript(transcript, { kind: 'gateway-event', createId: 'live-1', event: { type: 'message.delta', payload: { delta: 'Hello' } } })
    transcript = updateTranscript(transcript, { kind: 'gateway-event', createId: 'unused', event: { type: 'thinking.delta', payload: { text: 'Think' } } })
    transcript = updateTranscript(transcript, { kind: 'gateway-event', createId: 'unused', event: { type: 'reasoning.delta', payload: { delta: ' again' } } })
    transcript = updateTranscript(transcript, { kind: 'gateway-event', createId: 'unused', event: { type: 'message.complete', payload: { delta: '!' } } })

    expect(transcript.entries).toEqual([{ author: 'assistant', content: 'Hello!', id: 'live-1', kind: 'message', reasoning: 'Think again', streaming: false }])
  })

  it('preserves current empty completion and stored assistant append behavior', () => {
    const empty = updateTranscript(createTranscript(ordinary), {
      kind: 'gateway-event', createId: 'empty', event: { type: 'message.complete', payload: {} }
    })
    expect(empty.entries).toEqual([{ author: 'assistant', content: '', id: 'empty', kind: 'message', streaming: false }])

    const stored = updateTranscript(createTranscript(ordinary, [{ role: 'assistant', content: 'stored', row_id: 2 }]), {
      kind: 'gateway-event', createId: 'unused', event: { type: 'message.delta', payload: { delta: ' live' } }
    })
    expect(stored.entries[0]).toMatchObject({ content: 'stored live', id: 'history-row-2', streaming: true })
  })

  it('appends to assistant-authored unknown activity and creates after every non-assistant kind', () => {
    const activity = updateTranscript(createTranscript(ordinary, rows([{
      role: 'assistant', content: 'future', display_kind: 'future_kind'
    }])), { kind: 'gateway-event', createId: 'unused', event: { type: 'message.delta', payload: { delta: ' update' } } })
    expect(activity.entries[0]).toMatchObject({ content: 'future update', kind: 'activity', streaming: true })

    for (const row of [
      { role: 'user', content: 'user' },
      { role: 'system', content: 'system' },
      { role: 'tool', content: 'tool' }
    ]) {
      const transcript = updateTranscript(createTranscript(ordinary, rows([row])), {
        kind: 'gateway-event', createId: 'new', event: { type: 'message.delta', payload: {} }
      })
      expect(transcript.entries.at(-1)).toEqual({ author: 'assistant', content: '', id: 'new', kind: 'message', streaming: true })
    }
  })

  it('returns the original snapshot for ignored events and no-op updates', () => {
    const transcript = createTranscript(ordinary, [{ role: 'assistant', content: 'live', row_id: 1 }])
    expect(updateTranscript(transcript, { kind: 'gateway-event', createId: 'unused', event: { type: 'tool.start' } })).toBe(transcript)
    expect(updateTranscript(transcript, { kind: 'set-context', context: ordinary })).toBe(transcript)

    const changedContext = updateTranscript(transcript, {
      kind: 'set-context', context: { source: 'mobile', storedSessionId: 'stored-1' }
    })
    expect(changedContext).not.toBe(transcript)
    expect(changedContext.entries).toBe(transcript.entries)
  })
})

describe('Transcript identity and history transitions', () => {
  it('adds optimistic users and recomputes loaded ordinals after prepend', () => {
    let transcript = createTranscript(ordinary, [{ role: 'user', content: 'recent', row_id: 81 }])
    transcript = updateTranscript(transcript, { kind: 'local-user', content: 'local', id: 'local-1' })
    transcript = updateTranscript(transcript, {
      kind: 'prepend-history', fallbackOffset: 80,
      rows: [{ role: 'user', content: 'older', row_id: 80 }]
    })

    expect(transcript.entries[0]).toMatchObject({ editTarget: { rowId: 80, userOrdinal: 0 } })
    expect(transcript.entries[1]).toMatchObject({ editTarget: { rowId: 81, userOrdinal: 1 } })
    expect(transcript.entries[2]).toMatchObject({ id: 'local-1' })
    expect(transcript.entries[2]).not.toHaveProperty('editTarget')
  })

  it('uses effective offsets for no-ID pages and suppresses durable and same-position overlap', () => {
    let transcript = createTranscript(ordinary, [{ role: 'assistant', content: 'latest' }])
    transcript = updateTranscript(transcript, {
      kind: 'prepend-history', fallbackOffset: 80,
      rows: [{ role: 'assistant', content: 'older' }]
    })
    expect(transcript.entries.map(entry => entry.id)).toEqual(['history-80', 'history-0'])

    const unchanged = updateTranscript(transcript, {
      kind: 'prepend-history', fallbackOffset: 80,
      rows: [{ role: 'assistant', content: 'same position' }]
    })
    expect(unchanged).toBe(transcript)

    const durable = createTranscript(ordinary, [{ role: 'assistant', content: 'latest', row_id: 9 }])
    expect(updateTranscript(durable, {
      kind: 'prepend-history', fallbackOffset: 80,
      rows: [{ role: 'assistant', content: 'duplicate', row_id: 9 }]
    })).toBe(durable)
  })

  it('preserves the exact latest-page graft taxonomy', () => {
    const current = createTranscript(ordinary, rows([
      { role: 'assistant', content: 'old', row_id: 1 },
      { role: 'assistant', content: 'anchor', row_id: 2 },
      { role: 'assistant', content: 'live', row_id: 3 }
    ]))

    expect(contents(updateTranscript(current, { kind: 'reconcile-history', rows: [] }))).toEqual([])
    expect(contents(updateTranscript(current, { kind: 'reconcile-history', rows: [{ role: 'assistant', content: 'old fresh', row_id: 1 }] }))).toEqual(['old fresh'])
    expect(contents(updateTranscript(current, { kind: 'reconcile-history', rows: [{ role: 'assistant', content: 'anchor fresh', row_id: 2 }, { role: 'assistant', content: 'new', row_id: 4 }] }))).toEqual(['old', 'anchor fresh', 'new'])
    expect(contents(updateTranscript(current, { kind: 'reconcile-history', rows: [{ role: 'assistant', content: 'unanchored', row_id: 8 }] }))).toEqual(['unanchored'])
  })
})
