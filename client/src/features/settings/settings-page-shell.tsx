import type { ReactNode } from 'react'

export function SettingsPageShell({ children, leading, subtitle, title }: { children: ReactNode; leading?: ReactNode; subtitle?: string; title: string }) {
  return <section className="screen page-screen"><header className="page-heading">{leading}<div><p className="eyebrow">Settings</p><h2>{title}</h2></div></header>{subtitle && <p className="muted">{subtitle}</p>}{children}</section>
}
