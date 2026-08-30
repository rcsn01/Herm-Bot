import type { RemoteResourceDefinition } from '~/features/shared/remote-resource'

const PROCESS_SCOPED_OPERATION_MESSAGE = 'This gateway resource reads the process-wide installation and cannot be selected from a named profile.'

export const OPERATION_RESOURCES = [
  { id: 'cron', title: 'Cron', path: '/api/cron/jobs', description: 'Scheduled jobs, delivery state, and recent runs.' },
  { id: 'messaging', title: 'Messaging', path: '/api/messaging/platforms', description: 'Remote messaging platforms, setup, and health.' },
  { id: 'pairing', title: 'Pairing', path: '/api/pairing', description: 'Pending requests and approved users. Approval uses request identity, never a one-time code.' },
  { defaultProfileOnly: true, id: 'webhooks', title: 'Webhooks', path: '/api/webhooks', profileScoped: false, description: 'Webhook subscriptions and delivery state.', unavailableMessage: PROCESS_SCOPED_OPERATION_MESSAGE },
  { defaultProfileOnly: true, id: 'agents', title: 'Agents', path: '/api/agents', profileScoped: false, description: 'Current and recent delegated agent work.', unavailableMessage: PROCESS_SCOPED_OPERATION_MESSAGE }
] as const satisfies readonly RemoteResourceDefinition[]

export type OperationId = (typeof OPERATION_RESOURCES)[number]['id']
export const operationById = (id: string) => OPERATION_RESOURCES.find(item => item.id === id)
