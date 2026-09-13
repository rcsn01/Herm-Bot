import type { ReactNode } from 'react'

/**
 * Shared chrome for settings pages. Sub-pages pass their own title (the top
 * bar only ever reads "Settings") and optionally a `leading` control. The
 * root page sets `heading={false}`: the top bar already owns the "Settings"
 * title and the back navigation there, so repeating them in the body would
 * render three "Settings" and two back affordances on one screen.
 */
export function SettingsPageShell({ children, heading = true, leading, subtitle, title }: { children: ReactNode; heading?: boolean; leading?: ReactNode; subtitle?: string; title: string }) {
  return (
    <section className="screen page-screen">
      {heading && <header className="page-heading">{leading}<div><p className="eyebrow">Settings</p><h2>{title}</h2></div></header>}
      {subtitle && <p className="muted">{subtitle}</p>}
      {children}
    </section>
  )
}