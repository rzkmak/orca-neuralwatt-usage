import type { PluginSettings, Snapshot } from './protocol.ts'
import { clamp } from './settings.ts'

export const MINUTE_MS = 60_000
export const MAX_BACKOFF_MS = 30 * MINUTE_MS

/** Poll interval: the configured minutes, jittered ±10% so clients don't sync up. */
export function intervalMs(current: PluginSettings, random: number = Math.random()): number {
  return jitter(refreshMinutes(current) * MINUTE_MS, random)
}

/** Error backoff: interval × 2^failures (capped at 5 doublings), never above 30 minutes. */
export function backoffMs(current: PluginSettings, consecutiveFailures: number, random: number = Math.random()): number {
  const base = refreshMinutes(current) * MINUTE_MS
  return jitter(Math.min(base * 2 ** Math.min(consecutiveFailures, 5), MAX_BACKOFF_MS), random)
}

/** Next delay after a fetch attempt: normal interval on success, a 429 Retry-After when given, else backoff. */
export function nextDelayMs(current: PluginSettings, snapshot: Snapshot, consecutiveFailures: number, random: number = Math.random()): number {
  if (snapshot.ok) return intervalMs(current, random)
  if (snapshot.retryAfterMs !== null && snapshot.retryAfterMs > 0) {
    return Math.min(snapshot.retryAfterMs, MAX_BACKOFF_MS)
  }
  return backoffMs(current, consecutiveFailures, random)
}

export function refreshMinutes(current: PluginSettings): number {
  return clamp(current.refreshMinutes, 1, 60)
}

export function jitter(ms: number, random: number = Math.random()): number {
  return Math.round(ms * (0.9 + random * 0.2))
}
