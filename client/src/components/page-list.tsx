import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { Button } from '~/compat/primitives'

export function PageList({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`page-list${className ? ` ${className}` : ''}`}>{children}</div>
}

interface PageListButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> {
  description?: ReactNode
  leading?: ReactNode
  meta?: ReactNode
  title: ReactNode
  trailing?: ReactNode
}

/** A consistent navigation row for page-level lists. */
export function PageListButton({ className = '', description, leading, meta, title: label, trailing, type = 'button', ...props }: PageListButtonProps) {
  return (
    <Button {...props} className={`page-list-button${className ? ` ${className}` : ''}`} type={type} variant="ghost">
      {leading}
      <span className="page-list-button-copy">
        <strong>{label}</strong>
        {description && <small>{description}</small>}
        {meta && <small>{meta}</small>}
      </span>
      {trailing && <span className="page-list-button-trailing">{trailing}</span>}
    </Button>
  )
}
