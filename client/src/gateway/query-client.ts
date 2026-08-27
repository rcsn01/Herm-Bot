import { QueryClient, type QueryKey } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { retry: false },
    queries: {
      gcTime: 15 * 60_000,
      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
      retry: (count, error) => Boolean((error as { retryable?: boolean }).retryable) && count < 2,
      staleTime: 15_000
    }
  }
})

export async function cancelGatewayQueries(connectionKey?: string): Promise<void> {
  const queryKey: QueryKey = connectionKey ? ['gateway', connectionKey] : ['gateway']
  await queryClient.cancelQueries({ queryKey })
}

export function clearGatewayQueries(connectionKey?: string): void {
  const queryKey: QueryKey = connectionKey ? ['gateway', connectionKey] : ['gateway']
  queryClient.removeQueries({ queryKey })
}
