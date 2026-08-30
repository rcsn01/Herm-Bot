import type { ReactNode } from 'react'

export function SettingsPageShell({ children, subtitle, title }: { children: ReactNode; subtitle?: string; title: string }) {
  return <section className="screen page-screen"><header className="page-heading"><div><p className="eyebrow">Settings</p><h2>{title}</h2></div></header>{subtitle && <p className="muted">{subtitle}</p>}{children}</section>
}
