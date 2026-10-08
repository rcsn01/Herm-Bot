import type { TranscriptEntry } from './transcript'

export type AgentActivityStep =
  | { kind: 'reasoning'; id: string; content: string; streaming: boolean }
  | { kind: 'tool-output'; id: string; content: string }

export type TranscriptDisplayItem =
  | { kind: 'entry'; id: string; entry: Exclude<TranscriptEntry, { kind: 'tool-output' }> }
  | { kind: 'agent-activity'; id: string; steps: AgentActivityStep[] }

/** Presentation only: preserve transcript order, content, and durable identities. */
export function groupAgentActivity(entries: readonly TranscriptEntry[]): TranscriptDisplayItem[] {
  const items: TranscriptDisplayItem[] = []
  const appendStep = (step: AgentActivityStep) => {
    const previous = items.at(-1)
    if (previous?.kind === 'agent-activity') previous.steps.push(step)
    else items.push({ kind: 'agent-activity', id: `activity:${step.id}`, steps: [step] })
  }

  for (const entry of entries) {
    if (entry.kind === 'tool-output') {
      appendStep({ kind: 'tool-output', id: `output:${entry.id}`, content: entry.content })
    } else if (entry.kind === 'message' && entry.author === 'assistant' && entry.reasoning?.trim()) {
      appendStep({
        kind: 'reasoning',
        id: `reasoning:${entry.id}`,
        content: entry.reasoning,
        streaming: entry.streaming && !entry.content.trim()
      })
      if (entry.content.trim()) items.push({ kind: 'entry', id: entry.id, entry: { ...entry, reasoning: undefined } })
    } else {
      // User messages, substantive answers, cron instructions, and activity
      // events (including unknown kinds) are never buried in a work log.
      items.push({ kind: 'entry', id: entry.id, entry })
    }
  }
  return items
}
