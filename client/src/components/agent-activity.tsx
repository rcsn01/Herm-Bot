import { IconChevronDown } from '@tabler/icons-react'

import type { ToolActivity } from '~/lib/types'
import type { AgentActivityStep } from '~/transcript/agent-activity'

interface AgentActivityProps {
  steps?: readonly AgentActivityStep[]
  tools?: readonly ToolActivity[]
  running?: boolean
  hasSessionError?: boolean
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

export function AgentActivity({ steps = [], tools = [], running = steps.some(step => step.kind === 'reasoning' && step.streaming), hasSessionError = false }: AgentActivityProps) {
  const reasoningCount = steps.filter(step => step.kind === 'reasoning').length
  const outputCount = steps.filter(step => step.kind === 'tool-output').length
  const counts = [
    reasoningCount ? countLabel(reasoningCount, 'reasoning block') : null,
    outputCount ? countLabel(outputCount, 'tool output') : null,
    tools.length ? countLabel(tools.length, 'tool call') : null
  ].filter(Boolean).join(' · ')
  const currentTool = tools.findLast(tool => tool.status !== 'complete')
  const current = running
    ? currentTool ? `Running: ${currentTool.name}` : tools.length ? 'Waiting for next action' : 'Thinking'
    : currentTool ? `Not finished: ${currentTool.name}` : null

  return (
    <details className="agent-activity-card">
      <summary>
        <span aria-hidden="true" className={`agent-activity-dot${running ? ' working' : ''}`} />
        <span className="agent-activity-heading">
          <strong>{tools.length ? 'Session tool activity' : 'Agent activity'}</strong>
          <span className="agent-activity-counts">{counts}</span>
          {hasSessionError && <span className="agent-activity-error">Session error</span>}
          {current && <span className="agent-activity-current">{current}</span>}
        </span>
        <IconChevronDown aria-hidden="true" className="agent-activity-chevron" size={16} />
      </summary>
      <ol className="agent-activity-steps">
        {steps.map(step => (
          <li key={step.id}>
            <details className="agent-activity-step">
              <summary>
                <span>{step.kind === 'reasoning' ? 'Reasoning' : 'Tool output'}</span>
                {step.kind === 'reasoning' && step.streaming && <span className="agent-activity-step-status">Thinking</span>}
                <IconChevronDown aria-hidden="true" size={14} />
              </summary>
              <pre>{step.content || 'No output'}</pre>
            </details>
          </li>
        ))}
        {tools.map(tool => (
          <li key={`tool:${tool.id}`}>
            <details className="agent-activity-step">
              <summary>
                <span>{tool.name}</span>
                <span className="agent-activity-step-status">{!running && tool.status !== 'complete' ? 'Not finished' : tool.status}</span>
                <IconChevronDown aria-hidden="true" size={14} />
              </summary>
              <pre>{tool.detail || 'No details'}</pre>
            </details>
          </li>
        ))}
      </ol>
    </details>
  )
}
