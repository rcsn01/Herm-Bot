// Hermes Mobile owns routes and composed screens, but its reusable controls
// come from the same Moirasia package used by Orbis and Exithibition. The two
// small adapters preserve legacy mobile variant names while the app migrates
// screen-by-screen.
import { Badge as MoirasiaBadge } from '@moirasia/ui-react/components/badge'
import { Button as MoirasiaButton } from '@moirasia/ui-react/components/button'
import * as React from 'react'

export { Input } from '@moirasia/ui-react/components/input'
export { ScrollArea } from '@moirasia/ui-react/components/scroll-area'
export { Separator } from '@moirasia/ui-react/components/separator'
export { Skeleton } from '@moirasia/ui-react/components/skeleton'
export { Switch } from '@moirasia/ui-react/components/switch'
export { Tabs, TabsContent, TabsList, TabsTrigger } from '@moirasia/ui-react/components/tabs'
export { Textarea } from '@moirasia/ui-react/components/textarea'
export { Codicon } from './ui/codicon'
export { EmptyState } from './ui/empty-state'

type MobileButtonVariant = 'default' | 'destructive' | 'ghost' | 'link' | 'outline' | 'secondary' | 'text'
type MobileButtonSize = 'default' | 'icon' | 'icon-sm' | 'icon-xs' | 'lg' | 'micro' | 'sm'
type ButtonProps = Omit<React.ComponentProps<typeof MoirasiaButton>, 'size' | 'variant'> & {
  size?: MobileButtonSize
  variant?: MobileButtonVariant
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = '', size = 'default', variant = 'default', ...props },
  ref
) {
  const text = variant === 'text'
  const mappedSize = size === 'icon-sm' || size === 'icon-xs' ? 'icon' : size === 'micro' ? 'sm' : size
  return <MoirasiaButton
    {...props}
    className={`${text ? 'moirasia-text-button ' : ''}${size === 'icon-sm' ? 'moirasia-icon-button-sm ' : ''}${size === 'icon-xs' ? 'moirasia-icon-button-xs ' : ''}${size === 'micro' ? 'moirasia-micro-button ' : ''}${className}`.trim()}
    data-slot="button"
    ref={ref}
    size={mappedSize}
    variant={text ? 'ghost' : variant}
  />
})

type MobileBadgeVariant = 'default' | 'destructive' | 'muted' | 'outline' | 'solid' | 'warn'
type BadgeProps = Omit<React.ComponentProps<typeof MoirasiaBadge>, 'variant'> & {
  variant?: MobileBadgeVariant
}

export function Badge({ className = '', variant = 'default', ...props }: BadgeProps) {
  const mapped = variant === 'muted' ? 'secondary'
    : variant === 'solid' ? 'default'
      : variant === 'warn' ? 'outline'
        : variant
  return <MoirasiaBadge
    {...props}
    className={`${variant === 'warn' ? 'moirasia-warning-badge ' : ''}${className}`.trim()}
    variant={mapped}
  />
}
