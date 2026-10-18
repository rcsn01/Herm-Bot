import { useEffect, useState } from 'react'

import type { SessionUsage } from '~/lib/types'

const CACHE_WINDOW_MS = 60 * 60 * 1000
const cacheExplanation = 'Assumes a one-hour cache window from the last completed response observed in this conversation. The provider may evict the cache earlier, and a cache hit is not guaranteed. Reloading or switching conversations makes the estimate unknown until another response completes.'

export function ContextStatus({ active, lastResponseAt, usage }: {
  active: boolean
  lastResponseAt: number | null
  usage: SessionUsage | null
}) {
  const [now, setNow] = useState(Date.now)
  const deadline = lastResponseAt === null ? null : lastResponseAt + CACHE_WINDOW_MS
  useEffect(() => {
    if (!active) return
    const update = () => setNow(Date.now())
    update()
    if (deadline === null || deadline <= Date.now()) return
    const interval = setInterval(() => {
      update()
      if (Date.now() >= deadline) clearInterval(interval)
    }, 1000)
    document.addEventListener('visibilitychange', update)
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', update) }
  }, [active, deadline])

  const used = usage?.used ?? null
  const limit = usage?.limit ?? null
  const percent = used !== null && limit !== null ? Math.round(used / limit * 1000) / 10 : null
  const tokenLabel = used === null ? 'Usage unavailable' : limit === null ? `${used.toLocaleString()} tokens · limit unknown` : `${used.toLocaleString()} / ${limit.toLocaleString()}`
  const remaining = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000))
  const countdown = remaining === null ? 'unknown' : remaining === 0 ? 'window elapsed' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} left`

  return <div className="context-usage">
    <span title="Latest reported prompt context; unsent draft text is not included.">Context{percent === null ? '' : ` ${usage?.estimated ? '~' : ''}${percent}%`}</span>
    {percent !== null && limit !== null && used !== null ? <progress aria-label="Context used" aria-valuetext={`${tokenLabel} tokens${usage?.estimated ? ', estimated' : ''}`} max={limit} value={used} /> : <span />}
    <span className="context-token-count">{usage?.estimated && used !== null ? '~' : ''}{tokenLabel}</span>
    <span aria-live="off" className="context-cache-estimate" title={cacheExplanation}>Est. cache: {countdown}</span>
  </div>
}
