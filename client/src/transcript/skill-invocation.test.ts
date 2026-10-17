import { describe, expect, it } from 'vitest'
import { skillInvocationText } from './skill-invocation'
import { createTranscript, updateTranscript } from './transcript'

const skill = (instruction = '') => '[IMPORTANT: The user has invoked the "research" skill. The full skill content is loaded below.]\n\nPrivate skill body\n\n' +
  (instruction ? `The user has provided the following instruction alongside the skill invocation: ${instruction}` : '')
const context = { source: null, storedSessionId: 'stored-1' }

describe('skill invocation projection', () => {
  it('projects legacy skill payloads to their invocation, including after a fresh history load', () => {
    const rows = [{ role: 'user' as const, content: skill('the moon'), row_id: 1 }]
    const transcript = createTranscript(context, rows)
    expect(transcript.entries[0]).toMatchObject({ content: '/research the moon', author: 'user' })
    expect(JSON.stringify(transcript)).not.toContain('Private skill body')
    const local = updateTranscript(createTranscript(context), { kind: 'local-user', content: skill('the moon'), id: 'local-1' })
    expect(local.entries[0]).toMatchObject({ content: '/research the moon' })
  })

  it('keeps ordinary prose, assistant quotes, and explicit gateway display projections intact', () => {
    expect(skillInvocationText('Ordinary message')).toBeNull()
    expect(skillInvocationText('[IMPORTANT: read the docs]')).toBeNull()
    expect(skillInvocationText(skill())).toBe('/research')
    expect(createTranscript(context, [{ role: 'assistant', content: skill() }]).entries[0].content).toBe(skill())
    expect(createTranscript(context, [{ role: 'user', content: skill(), display_content: '/research exact words' }]).entries[0].content).toBe('/research exact words')
  })

  it('projects stacked skill bundles and normalizes instruction whitespace', () => {
    const bundle = '[IMPORTANT: The user has invoked the "/clean /research" skill bundle, loading skills.]\nUser instruction: ship\n it\n\n[Loaded as part of the bundle]\nPrivate skill body'
    expect(skillInvocationText(bundle)).toBe('/clean /research ship it')
    expect(skillInvocationText(skill('first\n\nsecond') + '\n\n[Runtime note: hidden]')).toBe('/research first second')
  })
})
