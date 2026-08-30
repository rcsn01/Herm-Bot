import type { SettingsAdministrationPage, SettingsCategory } from '~/navigation/routes'

export type BackendSettingsSectionId = Exclude<SettingsCategory, 'notifications' | 'keyboard-shortcuts' | 'about'>

export interface MobileSettingsSection {
  id: BackendSettingsSectionId
  keys: readonly string[]
  label: string
}

// Keep this metadata mobile-local. The mobile client is deployed independently
// and must not require a desktop/shared package export just to render settings.
export const BACKEND_SETTINGS_SECTIONS: readonly MobileSettingsSection[] = [
  { id: 'model', label: 'Model', keys: ['model_context_length', 'fallback_providers'] },
  { id: 'chat', label: 'Chat', keys: ['display.personality', 'timezone', 'display.show_reasoning', 'agent.image_input_mode'] },
  { id: 'appearance', label: 'Appearance', keys: [] },
  {
    id: 'workspace',
    label: 'Workspace',
    keys: ['terminal.cwd', 'desktop.repo_scan_enabled', 'desktop.repo_scan_roots', 'desktop.repo_scan_exclude_paths', 'code_execution.mode', 'terminal.persistent_shell', 'terminal.env_passthrough', 'file_read_max_chars']
  },
  {
    id: 'safety',
    label: 'Safety',
    keys: ['approvals.mode', 'approvals.timeout', 'approvals.mcp_reload_confirm', 'command_allowlist', 'security.redact_secrets', 'security.allow_private_urls', 'checkpoints.enabled']
  },
  { id: 'browser', label: 'Browser', keys: ['browser.use_real_profile', 'browser.allow_private_urls', 'browser.auto_local_for_private_urls'] },
  {
    id: 'memory',
    label: 'Memory & Context',
    keys: ['memory.memory_enabled', 'memory.user_profile_enabled', 'memory.memory_char_limit', 'memory.user_char_limit', 'memory.provider', 'context.engine', 'compression.enabled', 'compression.threshold', 'compression.target_ratio', 'compression.protect_last_n']
  },
  {
    id: 'voice',
    label: 'Voice',
    keys: [
      'tts.provider', 'stt.enabled', 'stt.echo_transcripts', 'stt.provider', 'voice.auto_tts', 'tts.edge.voice', 'tts.openai.model', 'tts.openai.voice',
      'tts.elevenlabs.voice_id', 'tts.elevenlabs.model_id', 'tts.xai.voice_id', 'tts.xai.language', 'tts.xai.speed', 'tts.xai.auto_speech_tags',
      'tts.xai.optimize_streaming_latency', 'tts.xai.sample_rate', 'tts.xai.bit_rate', 'tts.minimax.model', 'tts.minimax.voice_id', 'tts.mistral.model',
      'tts.mistral.voice_id', 'tts.gemini.model', 'tts.gemini.voice', 'tts.neutts.model', 'tts.neutts.device', 'tts.kittentts.model', 'tts.kittentts.voice',
      'tts.piper.voice', 'tts.deepinfra.model', 'tts.deepinfra.voice', 'stt.local.model', 'stt.local.language', 'stt.openai.model', 'stt.groq.model',
      'stt.mistral.model', 'stt.elevenlabs.model_id', 'stt.elevenlabs.language_code', 'stt.elevenlabs.tag_audio_events', 'stt.elevenlabs.diarize',
      'voice.record_key', 'voice.max_recording_seconds', 'voice.client_direct'
    ]
  },
  {
    id: 'advanced',
    label: 'Advanced',
    keys: [
      'toolsets', 'terminal.backend', 'terminal.timeout', 'terminal.docker_image', 'terminal.singularity_image', 'terminal.modal_image', 'terminal.daytona_image',
      'tool_output.max_bytes', 'tool_output.max_lines', 'tool_output.max_line_length', 'checkpoints.max_snapshots', 'agent.max_turns', 'agent.api_max_retries',
      'agent.service_tier', 'agent.tool_use_enforcement', 'delegation.model', 'delegation.provider', 'delegation.max_iterations', 'delegation.max_concurrent_children',
      'delegation.child_timeout_seconds', 'delegation.reasoning_effort', 'updates.non_interactive_local_changes'
    ]
  }
]

export interface SettingsEntry {
  category?: SettingsCategory
  description: string
  id: SettingsCategory | SettingsAdministrationPage
  label: string
  kind: 'administration' | 'config' | 'local'
  backendSection?: BackendSettingsSectionId
}

const backendEntries: SettingsEntry[] = BACKEND_SETTINGS_SECTIONS.map(section => ({
  backendSection: section.id,
  category: section.id,
  description: section.id === 'appearance' ? 'Theme and device presentation.' : `Profile defaults for ${section.label.toLowerCase()}.`,
  id: section.id,
  kind: 'config',
  label: section.label
}))

export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  ...backendEntries,
  { category: 'notifications', description: 'Foreground alerts and mobile limitations.', id: 'notifications', kind: 'local', label: 'Notifications' },
  { description: 'Plan, entitlement, balance, and usage.', id: 'billing', kind: 'administration', label: 'Billing' },
  { description: 'Provider accounts, OAuth, keys, and endpoints.', id: 'providers', kind: 'administration', label: 'Providers' },
  { description: 'Remote gateway, profiles, and connection controls.', id: 'gateway', kind: 'administration', label: 'Gateways' },
  { category: 'keyboard-shortcuts', description: 'Implemented mobile shortcuts and unsupported rebinding.', id: 'keyboard-shortcuts', kind: 'local', label: 'Keyboard Shortcuts' },
  { description: 'Redacted credentials and tool provider setup.', id: 'tools-keys', kind: 'administration', label: 'Tools & Keys' },
  { description: 'Installed plugin inventory and supported actions.', id: 'plugins', kind: 'administration', label: 'Plugins' },
  { description: 'Archived sessions for this profile.', id: 'archived-chats', kind: 'administration', label: 'Archived Chats' },
  { description: 'Mobile, gateway, contract, and support information.', id: 'about', kind: 'local', label: 'About' }
]

export const SETTINGS_ADMINISTRATION_ENTRIES: readonly SettingsEntry[] = SETTINGS_ENTRIES.filter(entry => entry.kind === 'administration')

export function settingsEntry(id: string): SettingsEntry | undefined {
  return SETTINGS_ENTRIES.find(entry => entry.id === id && (entry.kind !== 'config' || entry.category === id))
}

export function settingsBackendSection(id: string): MobileSettingsSection | undefined {
  return BACKEND_SETTINGS_SECTIONS.find(section => section.id === id)
}
