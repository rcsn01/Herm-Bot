import { describe, expect, it } from 'vitest'

import { sentenceCaseLabel } from './labels'

describe('sentenceCaseLabel', () => {
  it.each([
    ['available_providers', 'Available providers'],
    ['context_length', 'Context length'],
    ['api_key', 'API key'],
    ['base_url', 'Base URL'],
    ['cwd', 'CWD'],
    ['mcp_reload_confirm', 'MCP reload confirm'],
    ['OPENROUTER_API_KEY', 'OPENROUTER API KEY'],
    ['OpenRouter_API_KEY', 'OpenRouter API KEY'],
    ['MEMORY.md', 'MEMORY.md'],
    ['USER.md', 'USER.md'],
    ['SKILL.md', 'SKILL.md'],
    ['ios_profile', 'iOS profile'],
    ['oauth_provider', 'OAuth provider']
  ])('formats %s as %s', (value, expected) => {
    expect(sentenceCaseLabel(value)).toBe(expected)
  })
})
