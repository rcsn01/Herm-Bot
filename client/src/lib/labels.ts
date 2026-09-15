const PRESERVED_TERMS: Readonly<Record<string, string>> = {
  api: 'API',
  apis: 'APIs',
  apns: 'APNs',
  cli: 'CLI',
  cpu: 'CPU',
  cwd: 'CWD',
  css: 'CSS',
  docker: 'Docker',
  electron: 'Electron',
  git: 'Git',
  gpu: 'GPU',
  hermes: 'Hermes',
  http: 'HTTP',
  https: 'HTTPS',
  id: 'ID',
  ids: 'IDs',
  ios: 'iOS',
  json: 'JSON',
  mcp: 'MCP',
  moa: 'MoA',
  oauth: 'OAuth',
  pdf: 'PDF',
  pr: 'PR',
  pwa: 'PWA',
  ram: 'RAM',
  rest: 'REST',
  sql: 'SQL',
  ssh: 'SSH',
  stt: 'STT',
  tts: 'TTS',
  ui: 'UI',
  url: 'URL',
  urls: 'URLs',
  websocket: 'WebSocket',
  websockets: 'WebSockets',
  xai: 'xAI'
}

function preserveTerm(term: string): string {
  const preserved = PRESERVED_TERMS[term.toLowerCase()]
  if (preserved) return preserved
  if (/^[A-Z0-9]+(?:[._-][A-Z0-9]+)*$/.test(term) && /[A-Z]/.test(term)) return term
  if (/[a-z][A-Z]/.test(term)) return term
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+$/.test(term)) return term
  return ''
}

export function sentenceCaseLabel(value: string): string {
  const trimmed = value.trim()
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+$/.test(trimmed)) return trimmed

  let wordIndex = 0
  return value.replaceAll('_', ' ').split(/(\s+)/).map(part => {
    if (/^\s+$/.test(part)) return part
    const isFirst = wordIndex === 0
    wordIndex += 1
    const preserved = preserveTerm(part)
    if (preserved) return preserved
    const firstLetter = part.match(/[A-Za-z]/)?.[0]
    if (!firstLetter) return part
    const start = part.indexOf(firstLetter)
    const prefix = part.slice(0, start)
    const rest = part.slice(start + 1)
    return `${prefix}${isFirst ? firstLetter.toUpperCase() : firstLetter.toLowerCase()}${rest}`
  }).join('')
}
