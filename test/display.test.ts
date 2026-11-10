import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchQuota, normalizeQuotaPayload } from '../src/neuralwatt.ts'
import { initialPaint, paintFor, unconfiguredPaint } from '../src/display.ts'
import type { PluginSettings, Snapshot } from '../src/protocol.ts'

const FULL_PAYLOAD = {
  subscription: {
    plan: 'Pro',
    kwh_included: 100,
    kwh_used: 42.5,
    kwh_reset_date: '2030-01-01T00:00:00Z'
  },
  key: {
    allowance: { spent_usd: 12.4, limit_usd: 20, period: 'monthly', reset_at: 1_893_456_000, blocked: false }
  },
  balance: { credits_remaining_usd: 18.2 }
}

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

/** Build an ok snapshot through the real normalizer, then override fields. */
async function okSnapshot(payload: unknown = FULL_PAYLOAD, overrides: Partial<Snapshot> = {}): Promise<Snapshot> {
  const base = await fetchQuota('nw_key', { fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload }) })
  return { ...base, ...overrides }
}

async function errorSnapshot(error: string, overrides: Partial<Snapshot> = {}): Promise<Snapshot> {
  const base = await fetchQuota('nw_key', {
    fetchImpl: async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) })
  })
  return { ...base, error, ...overrides }
}

test('unconfigured paint asks for the API key', () => {
  const paint = unconfiguredPaint()
  assert.equal(paint.text, 'NeuralWatt Balance · set key')
  assert.equal(paint.tone, 'neutral')
  assert.match(paint.tooltip, /Settings → Plugins → NeuralWatt Usage/)

  const initial = initialPaint(false)
  assert.equal(initial.text, 'NeuralWatt Balance · set key')
  assert.equal(initialPaint(true).text, 'NeuralWatt Balance …')
})

test('normal paint: percent and credits, primary window is the allowance', async () => {
  const snapshot = await okSnapshot()
  const paint = paintFor(makeSettings(), snapshot, null)
  assert.equal(paint.text, 'NeuralWatt Balance 62% · $18.20')
  assert.equal(paint.tone, 'neutral')
  assert.match(paint.tooltip, /^NeuralWatt\n/)
  assert.match(paint.tooltip, /Pro: 43% of 100 kWh · resets in/)
  assert.match(paint.tooltip, /Monthly: \$12\.40 of \$20 · resets in/)
  assert.match(paint.tooltip, /Credits: \$18\.20/)
  assert.match(paint.tooltip, /Updated just now/)
})

test('normal paint: display modes', async () => {
  const snapshot = await okSnapshot()
  assert.equal(paintFor(makeSettings({ display: 'percent' }), snapshot, null).text, 'NeuralWatt Balance 62%')
  assert.equal(paintFor(makeSettings({ display: 'credits' }), snapshot, null).text, 'NeuralWatt Balance $18.20')
})

test('normal paint: plan window is primary when no allowance exists', async () => {
  // No balance in the payload, so no credits part in the text.
  const snapshot = await okSnapshot({
    subscription: { plan: 'Pro', kwh_included: 100, kwh_used: 42.5 }
  })
  const paint = paintFor(makeSettings(), snapshot, null)
  assert.equal(paint.text, 'NeuralWatt Balance 43%')
  assert.equal(paint.tone, 'neutral')
})

test('paint tones: warning at 75, danger at 90', async () => {
  const warning = await okSnapshot({
    key: { allowance: { spent_usd: 16, limit_usd: 20, period: 'monthly' } },
    balance: { credits_remaining_usd: 100 }
  })
  assert.equal(paintFor(makeSettings(), warning, null).tone, 'warning')

  const danger = await okSnapshot({
    key: { allowance: { spent_usd: 19, limit_usd: 20, period: 'monthly' } },
    balance: { credits_remaining_usd: 100 }
  })
  const paint = paintFor(makeSettings(), danger, null)
  assert.equal(paint.text, 'NeuralWatt Balance 95% · $100')
  assert.equal(paint.tone, 'danger')
})

test('paint: overage and blocked show the over state in danger', async () => {
  const over = await okSnapshot({
    subscription: { plan: 'Pro', kwh_included: 100, kwh_used: 105, in_overage: true }
  })
  const overPaint = paintFor(makeSettings(), over, null)
  assert.equal(overPaint.text, 'NeuralWatt Balance · over')
  assert.equal(overPaint.tone, 'danger')

  const blocked = await okSnapshot({
    key: { allowance: { spent_usd: 25, limit_usd: 20, period: 'daily', blocked: true } }
  })
  const blockedPaint = paintFor(makeSettings(), blocked, null)
  assert.equal(blockedPaint.text, 'NeuralWatt Balance · over')
  assert.equal(blockedPaint.tone, 'danger')
})

test('paint: no API key wins over everything', async () => {
  const snapshot = await okSnapshot()
  assert.equal(paintFor(makeSettings({ apiKey: '' }), snapshot, snapshot).text, 'NeuralWatt Balance · set key')
})

test('paint: error with a cached snapshot keeps the last good text', async () => {
  const lastGood = await okSnapshot()
  const failing = await errorSnapshot('API error: 500')
  const paint = paintFor(makeSettings(), failing, lastGood)
  assert.equal(paint.text, 'NeuralWatt Balance 62% · $18.20')
  assert.equal(paint.tone, 'neutral')
  assert.match(paint.tooltip, /⚠ API error: 500 · updated just now/)
})

test('paint: error without a cached snapshot shows offline', async () => {
  const failing = await errorSnapshot('Request timed out')
  const paint = paintFor(makeSettings(), failing, null)
  assert.equal(paint.text, 'NeuralWatt Balance · offline')
  assert.equal(paint.tone, 'warning')
  assert.match(paint.tooltip, /Request timed out/)
  assert.match(paint.tooltip, /Click to retry\./)
})

test('paint: credits-only snapshot', async () => {
  const snapshot = await okSnapshot({ balance: { credits_remaining_usd: 18.2 } })
  const paint = paintFor(makeSettings(), snapshot, null)
  assert.equal(paint.text, 'NeuralWatt Balance $18.20')
  assert.equal(paint.tone, 'neutral')
  assert.match(paint.tooltip, /Credits: \$18\.20/)
  assert.ok(!paint.tooltip.includes('credits_balance'))
})

test('paint: tooltip labels a key borrowed from OpenCode', async () => {
  const snapshot = await okSnapshot()
  const paint = paintFor(makeSettings(), snapshot, null, 'opencode')
  assert.match(paint.tooltip, /^NeuralWatt · key from OpenCode\n/)
  const withSetting = paintFor(makeSettings(), snapshot, null, 'setting')
  assert.match(withSetting.tooltip, /^NeuralWatt\n/)
})

test('paint: unconfigured hint mentions the OpenCode fallback', () => {
  const paint = unconfiguredPaint()
  assert.match(paint.tooltip, /Settings → Plugins → NeuralWatt Usage/)
  assert.match(paint.tooltip, /OpenCode/)
})

// --- edge branches ---------------------------------------------------------

/** Builds an ok snapshot straight from the normalizer, bypassing fetchQuota's empty-window guard. */
function snapshotFrom(payload: unknown, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    ok: true,
    configured: true,
    error: null,
    fetchedAt: Date.now(),
    retryAfterMs: null,
    ...normalizeQuotaPayload(payload),
    ...overrides
  }
}

test('paint: a window without usable amounts falls back to percent-only rendering', () => {
  const snapshot = snapshotFrom(FULL_PAYLOAD, {
    windows: {
      plan: { key: 'plan', title: 'Pro', usedPercent: 50, windowSeconds: null, resetAt: null, valueLabel: null, used: null, limit: null, unit: 'kwh' }
    },
    planKey: 'plan'
  })
  const paint = paintFor(makeSettings({ display: 'percent' }), snapshot, null)
  assert.equal(paint.text, 'NeuralWatt Balance 50%')
  assert.match(paint.tooltip, /^Pro: 50%$/m) // percent only, no "of" segment
})

test('paint: a valueLabel-only window renders its label in the tooltip', () => {
  const snapshot = snapshotFrom({}, {
    windows: {
      gift: { key: 'gift', title: 'Gift', usedPercent: null, windowSeconds: null, resetAt: null, valueLabel: '$9.00', used: null, limit: null, unit: null }
    }
  })
  const paint = paintFor(makeSettings({ display: 'percent' }), snapshot, null)
  assert.equal(paint.text, 'NeuralWatt Balance') // no percent, no credits anywhere
  assert.match(paint.tooltip, /Gift: \$9\.00/)
})

test('paint: billing-cycle title and overdue resets render', () => {
  const snapshot = snapshotFrom({
    key: { allowance: { spent_usd: 1, limit_usd: 10, period: 'fortnight', reset_at: Math.floor(Date.now() / 1000) - 60 } }
  })
  const paint = paintFor(makeSettings(), snapshot, null)
  assert.match(paint.tooltip, /Billing cycle: \$1 of \$10 · reset overdue/)
})

test('paint: a plan window without reset info shows no reset segment', () => {
  const snapshot = snapshotFrom({ subscription: { plan: 'Pro', kwh_included: 100, kwh_used: 42.5 } })
  const paint = paintFor(makeSettings(), snapshot, null)
  assert.match(paint.tooltip, /Pro: 43% of 100 kWh\n/)
  assert.ok(!paint.tooltip.includes('resets in'))
})

test('paint: tone boundaries at exactly 75 and 90', async () => {
  const toneFor = async (spent: number): Promise<string> => {
    const snapshot = snapshotFrom({ key: { allowance: { spent_usd: spent, limit_usd: 100, period: 'monthly' } } })
    return paintFor(makeSettings(), snapshot, null).tone
  }
  assert.equal(await toneFor(74.9), 'neutral')
  assert.equal(await toneFor(75), 'warning')
  assert.equal(await toneFor(89.9), 'warning')
  assert.equal(await toneFor(90), 'danger')
})

test('paint: nothing computable renders the bare label', () => {
  const snapshot = snapshotFrom({})
  assert.equal(paintFor(makeSettings(), snapshot, null).text, 'NeuralWatt Balance')
})

test('paint: overage and blocked together', () => {
  const snapshot = snapshotFrom({
    subscription: { plan: 'Pro', kwh_included: 100, kwh_used: 110, in_overage: true },
    key: { allowance: { spent_usd: 25, limit_usd: 20, period: 'daily', blocked: true } }
  }, { creditsRemainingUsd: 0 })
  const paint = paintFor(makeSettings(), snapshot, null)
  assert.equal(paint.text, 'NeuralWatt Balance · over')
  assert.equal(paint.tone, 'danger')
})

test('paint: a blank error message falls back to "Request failed"', async () => {
  const failing = await errorSnapshot('')
  const offline = paintFor(makeSettings(), failing, null)
  assert.match(offline.tooltip, /^Request failed\nClick to retry\.$/)

  const lastGood = await okSnapshot()
  const blankFailure = await errorSnapshot('')
  const withCache = paintFor(makeSettings(), blankFailure, lastGood)
  assert.match(withCache.tooltip, /⚠ Request failed · updated just now/)
})

test('normalize spot-check used by the fixtures above', () => {
  const result = normalizeQuotaPayload(FULL_PAYLOAD)
  assert.deepEqual(Object.keys(result.windows).sort(), ['Pro', 'monthly'])
})
