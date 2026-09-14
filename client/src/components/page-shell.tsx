import type { ReactNode } from 'react'

export interface PageHeadingProps {
  actions?: ReactNode
  className?: string
  eyebrow?: ReactNode
  leading?: ReactNode
  level?: 2 | 3
  title: ReactNode
}

export function PageHeading({ actions, className = '', eyebrow, leading, level = 2, title }: PageHeadingProps) {
  const Heading = level === 3 ? 'h3' : 'h2'
  return (
    <header className={`page-heading${className ? ` ${className}` : ''}`}>
      <div className="page-heading-main">
        {leading}
        <div className="page-heading-copy">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <Heading>{title}</Heading>
        </div>
      </div>
      {actions && <div className="page-heading-actions">{actions}</div>}
    </header>
  )
}

export interface PageShellProps {
  actions?: ReactNode
  children: ReactNode
  className?: string
  eyebrow?: ReactNode
  heading?: boolean
  leading?: ReactNode
  subtitle?: ReactNode
  title: ReactNode
}

/**
 * Shared layout for scrollable, non-chat pages.
 *
 * The shell owns the page geometry and heading rhythm. Screens provide only
 * their identity and controls, so spacing and narrow-width behaviour stay
 * consistent as new pages are added.
 */
export function PageShell({ actions, children, className = '', eyebrow, heading = true, leading, subtitle, title }: PageShellProps) {
  return (
    <section className={`screen page-screen${className ? ` ${className}` : ''}`}>
      {heading ? <PageHeading actions={actions} eyebrow={eyebrow} leading={leading} title={title} /> : actions ? <div className="page-actions">{actions}</div> : null}
      {subtitle && <p className="page-subtitle muted">{subtitle}</p>}
      {children}
    </section>
  )
}
