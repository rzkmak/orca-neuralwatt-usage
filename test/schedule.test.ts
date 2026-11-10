import test from 'node:test'
import assert from 'node:assert/strict'
import { backoffMs, intervalMs, jitter, nextDelayMs, refreshMinutes, MAX_BACKOFF_MS, MINUTE_MS } from '../src/schedule.ts'
import type { PluginSettings, Snapshot } from '../src/protocol.ts'

function makeSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    apiKey: 'nw_key',
    refreshMinutes: 5,
    display: 'both',
    openCodeUrl: '',
    openCodePassword: '',
    ...overrides
  }
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    ok: false,
    configured: true,
    error: 'API error: 500',
    fetchedAt: Date.now(),
    inOverage: false,
    blocked: false,
    creditsRemainingUsd: null,
    planKey: null,
    windows: {},
    retryAfterMs: null,
    ...overrides
  }
}

test('jitter stays within ±10% and is injectable for determinism', () => {
  assert.equal(jitter(100, 0), 90)
  assert.equal(jitter(100, 0.5), 100)
  assert.equal(jitter(100, 1), 110)
  const real = jitter(100)
  assert.ok(real >= 90 && real <= 110)
})

test('refreshMinutes clamps to the declared 1–60 range', () => {
  assert.equal(refreshMinutes(makeSettings({ refreshMinutes: 0 })), 1)
  assert.equal(refreshMinutes(makeSettings({ refreshMinutes: -10 })), 1)
  assert.equal(refreshMinutes(makeSettings({ refreshMinutes: 120 })), 60)
  assert.equal(refreshMinutes(makeSettings({ refreshMinutes: 7 })), 7)
})

test('intervalMs is the configured minutes, jittered', () => {
  assert.equal(intervalMs(makeSettings({ refreshMinutes: 5 }), 0.5), 5 * MINUTE_MS)
  assert.equal(intervalMs(makeSettings({ refreshMinutes: 5 }), 0), 4.5 * MINUTE_MS)
  assert.equal(intervalMs(makeSettings({ refreshMinutes: 5 }), 1), 5.5 * MINUTE_MS)
  assert.equal(intervalMs(makeSettings({ refreshMinutes: 0 }), 0.5), MINUTE_MS)
})

test('backoffMs doubles per failure and never exceeds 30 minutes', () => {
  const settings = makeSettings({ refreshMinutes: 5 })
  const mid = 0.5
  assert.equal(backoffMs(settings, 0, mid), 5 * MINUTE_MS)
  assert.equal(backoffMs(settings, 1, mid), 10 * MINUTE_MS)
  assert.equal(backoffMs(settings, 2, mid), 20 * MINUTE_MS)
  // 2³ = 40 min already crosses the 30-minute cap…
  assert.equal(backoffMs(settings, 3, mid), MAX_BACKOFF_MS)
  assert.equal(backoffMs(settings, 5, mid), MAX_BACKOFF_MS)
  // …and the exponent stops growing past 5 doublings anyway.
  assert.equal(backoffMs(settings, 10, mid), MAX_BACKOFF_MS)
  // A long base interval is capped immediately: 2 × 60 min → 30 min.
  assert.equal(backoffMs(makeSettings({ refreshMinutes: 60 }), 1, mid), MAX_BACKOFF_MS)
})

test('nextDelayMs: success returns the normal interval', () => {
  const snapshot = makeSnapshot({ ok: true })
  assert.equal(nextDelayMs(makeSettings(), snapshot, 4, 0.5), 5 * MINUTE_MS)
})

test('nextDelayMs: a 429 Retry-After wins, capped at 30 minutes', () => {
  const snapshot = makeSnapshot({ retryAfterMs: 45_000 })
  assert.equal(nextDelayMs(makeSettings(), snapshot, 0, 0.5), 45_000)
  const huge = makeSnapshot({ retryAfterMs: 3_600_000 })
  assert.equal(nextDelayMs(makeSettings(), huge, 0, 0.5), MAX_BACKOFF_MS)
})

test('nextDelayMs: zero or missing Retry-After falls through to backoff', () => {
  const zero = makeSnapshot({ retryAfterMs: 0 })
  assert.equal(nextDelayMs(makeSettings(), zero, 2, 0.5), 20 * MINUTE_MS)
  const none = makeSnapshot({ retryAfterMs: null })
  assert.equal(nextDelayMs(makeSettings(), none, 0, 0.5), 5 * MINUTE_MS)
})
