import { describe, expect, it } from 'vitest'

import { groupAgentActivity } from './agent-activity'
import type { ConversationEntry, ToolOutputEntry, TranscriptEntry } from './transcript'

const reasoning = (id: string, content = '', streaming = false): ConversationEntry => ({
  id, kind: 'message', author: 'assistant', content, reasoning: `Reason ${id}`, streaming
})
const output = (id: string): ToolOutputEntry => ({ id, kind: 'tool-output', content: `Output ${id}` })
const message = (id: string, author: 'assistant' | 'user'): ConversationEntry => ({ id, kind: 'message', author, content: id, streaming: false })

describe('agent activity presentation', () => {
  it('groups consecutive reasoning and tool outputs without changing the transcript', () => {
    const entries = [reasoning('a'), output('b'), reasoning('c'), output('d')]
    for (const entry of entries) Object.freeze(entry)
    Object.freeze(entries)
    const result = groupAgentActivity(entries)
    expect(result).toEqual([{
      kind: 'agent-activity', id: 'activity:reasoning:a', steps: [
        { kind: 'reasoning', id: 'reasoning:a', content: 'Reason a', streaming: false },
        { kind: 'tool-output', id: 'output:b', content: 'Output b' },
        { kind: 'reasoning', id: 'reasoning:c', content: 'Reason c', streaming: false },
        { kind: 'tool-output', id: 'output:d', content: 'Output d' }
      ]
    }])
    expect(entries[0]).toHaveProperty('reasoning', 'Reason a')
  })

  it('ends groups at user messages, assistant answers, activity events, and cron instructions', () => {
    const boundaries: TranscriptEntry[] = [
      message('user', 'user'), message('answer', 'assistant'),
      { id: 'event', kind: 'activity', activityKind: 'error', author: 'system', content: 'Needs attention', streaming: false },
      { id: 'cron', kind: 'cron-instructions', originalKind: 'message', content: 'Instructions', streaming: false }
    ]
    const result = groupAgentActivity(boundaries.flatMap((entry, index) => [output(`before-${index}`), entry]))
    expect(result.map(item => item.kind)).toEqual(['agent-activity', 'entry', 'agent-activity', 'entry', 'agent-activity', 'entry', 'agent-activity', 'entry'])
    const renderedEntries = result.flatMap(item => item.kind === 'entry' ? [item.entry] : [])
    expect(renderedEntries).toEqual(boundaries)
  })

  it('puts mixed reasoning before an answer and keeps answer metadata intact', () => {
    const entry = { ...reasoning('mixed', 'The answer', true), rowId: 10 }
    const result = groupAgentActivity([output('before'), entry, output('after')])
    expect(result.map(item => item.kind)).toEqual(['agent-activity', 'entry', 'agent-activity'])
    expect(result[1]).toEqual({ kind: 'entry', id: 'mixed', entry: { ...entry, reasoning: undefined } })
    expect(result[0]).toMatchObject({ steps: [{ id: 'output:before' }, { id: 'reasoning:mixed', streaming: false }] })
    expect(entry).toHaveProperty('reasoning', 'Reason mixed')
  })

  it('keeps a group identity stable as reasoning streams, tools append, and the answer arrives', () => {
    const initial = groupAgentActivity([reasoning('stream', '', true)])
    const withOutput = groupAgentActivity([reasoning('stream', '', true), output('tool')])
    const withAnswer = groupAgentActivity([reasoning('stream', 'Final answer', true), output('tool')])
    expect(initial[0].id).toBe(withOutput[0].id)
    expect(initial[0].id).toBe(withAnswer[0].id)
    expect(initial[0]).toMatchObject({ steps: [{ streaming: true }] })
  })

  it('does not hide an empty streaming placeholder or user reasoning', () => {
    const entries: TranscriptEntry[] = [
      { ...message('placeholder', 'assistant'), content: '', streaming: true },
      { ...message('user', 'user'), reasoning: 'User metadata' }
    ]
    expect(groupAgentActivity(entries)).toEqual(entries.map(entry => ({ kind: 'entry', id: entry.id, entry })))
  })

  it('preserves empty tool output and handles an empty transcript', () => {
    expect(groupAgentActivity([])).toEqual([])
    expect(groupAgentActivity([{ id: 'empty', kind: 'tool-output', content: '' }])).toMatchObject([{ steps: [{ content: '' }] }])
  })
})
