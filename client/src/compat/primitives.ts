// These are deliberately the only imports from Desktop. They are leaf-level,
// stable visual primitives; mobile owns routes, state, and composed screens.
export { Badge } from '../../../../desktop/src/components/ui/badge'
export { Button } from '../../../../desktop/src/components/ui/button'
export { Codicon } from '../../../../desktop/src/components/ui/codicon'
export { EmptyState } from '../../../../desktop/src/components/ui/empty-state'
export { Input } from '../../../../desktop/src/components/ui/input'
export { ScrollArea } from '../../../../desktop/src/components/ui/scroll-area'
export { Separator } from '../../../../desktop/src/components/ui/separator'
export { Skeleton } from '../../../../desktop/src/components/ui/skeleton'
export { Switch } from '../../../../desktop/src/components/ui/switch'
export { Tabs, TabsList, TabsTrigger } from '../../../../desktop/src/components/ui/tabs'
export { Textarea } from '../../../../desktop/src/components/ui/textarea'

import { Tabs as TabsPrimitive } from 'radix-ui'
export const TabsContent = TabsPrimitive.Content
