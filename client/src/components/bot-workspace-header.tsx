import { IconChevronLeft } from '@tabler/icons-react'

import { Button } from '~/compat/primitives'

interface BotWorkspaceHeaderProps {
  backLabel: string
  botName: string
  className?: string
  onBack(): void
  onIdentityClick?(): void
  subtitle: string
}

export function BotWorkspaceHeader({ backLabel, botName, className = '', onBack, onIdentityClick, subtitle }: BotWorkspaceHeaderProps) {
  const identity = <div><strong>{botName}</strong><small>{subtitle}</small></div>

  return (
    <header className={`app-header bot-workspace-header${className ? ` ${className}` : ''}`}>
      <Button aria-label={backLabel} className="header-back-button" onClick={onBack} variant="ghost"><IconChevronLeft aria-hidden className="size-6" /></Button>
      {onIdentityClick
        ? <button aria-label="Open bot chat" className="header-bot-button" onClick={onIdentityClick}>{identity}</button>
        : <div className="header-bot-button">{identity}</div>}
      <span aria-hidden="true" className="header-action-spacer" />
    </header>
  )
}
