export interface HermesPushPayload {
  body: string
  tag: string
  title: string
  url: string
}

const text = (value: unknown, fallback: string, limit: number) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : fallback

export function parsePushPayload(value: unknown, origin: string): HermesPushPayload {
  const payload = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  let url = '/'
  if (typeof payload.url === 'string') {
    try {
      const candidate = new URL(payload.url, origin)
      if (candidate.origin === origin) url = `${candidate.pathname}${candidate.search}${candidate.hash}`
    } catch {
      // Keep the safe app root fallback.
    }
  }
  return {
    body: text(payload.body, 'Your Hermes task is ready.', 500),
    tag: text(payload.tag, 'hermes-turn-complete', 100),
    title: text(payload.title, 'Hermes', 100),
    url
  }
}
