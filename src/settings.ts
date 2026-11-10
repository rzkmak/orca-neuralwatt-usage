import type { DisplayMode, PluginSettings } from './protocol.ts'

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function asDisplayMode(value: unknown): DisplayMode {
  return value === 'percent' || value === 'credits' ? value : 'both'
}

/** Normalizes what `orca.settings.get()` returns, applying declared defaults and bounds. */
export function normalizeRawSettings(raw: Record<string, unknown>): PluginSettings {
  const minutes = typeof raw.refreshMinutes === 'number' && Number.isFinite(raw.refreshMinutes) ? raw.refreshMinutes : 5
  return {
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    refreshMinutes: clamp(minutes, 1, 60),
    display: asDisplayMode(raw.display),
    openCodeUrl: typeof raw.openCodeUrl === 'string' ? raw.openCodeUrl.trim() : '',
    openCodePassword: typeof raw.openCodePassword === 'string' ? raw.openCodePassword.trim() : ''
  }
}
