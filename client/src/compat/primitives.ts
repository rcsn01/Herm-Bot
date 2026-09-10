// These are deliberately the only compatibility imports from the shared UI
// vocabulary. They are leaf-level visual primitives; mobile owns routes,
// state, and composed screens.
export { Badge } from './ui/badge'
export { Button } from './ui/button'
export { Codicon } from './ui/codicon'
export { EmptyState } from './ui/empty-state'
export { Input } from './ui/input'
export { ScrollArea } from './ui/scroll-area'
export { Separator } from './ui/separator'
export { Skeleton } from './ui/skeleton'
export { Switch } from './ui/switch'
export { Tabs, TabsList, TabsTrigger } from './ui/tabs'
export { Textarea } from './ui/textarea'

import { Tabs as TabsPrimitive } from 'radix-ui'
export const TabsContent = TabsPrimitive.Content
