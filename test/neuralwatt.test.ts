import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchQuota, normalizeQuotaPayload, toTimestamp } from '../src/neuralwatt.ts'
import type { FetchLike, FetchResponseLike } from '../src/neuralwatt.ts'

const fullPayload = {
  subscription: {
    plan: 'Pro',
    kwh_included: 100,
    kwh_used: 42.5,
    kwh_reset_date: '2030-01-01T00:00:00Z',
    in_overage: false
  },
  key: {
    allowance: { spent_usd: 12.4, limit_usd: 20, period: 'monthly', reset_at: 1893456000, blocked: false }
  },
  balance: { credits_remaining_usd: 18.2 }
}

function stubResponse(body: unknown, status = 200, retryAfter: string | null = null): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
    json: async () => body
  }
}

function stubFetch(response: FetchResponseLike | Error): FetchLike {
  return async () => {
    if (response instanceof Error) throw response
    return response
  }
}

const NOW = 1_700_000_000_000

test('normalize: full payload yields plan, allowance and credits', () => {
  const result = normalizeQuotaPayload(fullPayload)

  assert.equal(result.planKey, 'Pro')
  assert.equal(result.inOverage, false)
  assert.equal(result.blocked, false)
  assert.equal(result.creditsRemainingUsd, 18.2)

  const plan = result.windows.Pro
  assert.equal(plan.usedPercent, 42.5)
  assert.equal(plan.unit, 'kwh')
  assert.equal(plan.used, 42.5)
  assert.equal(plan.limit, 100)
  assert.equal(plan.windowSeconds, null)
  assert.equal(plan.resetAt, Date.parse('2030-01-01T00:00:00Z'))

  const monthly = result.windows.monthly
  // Effective limit: min(limit 20, credits 18.2 + spent 12.4 = 30.6) = 20 → 62%
  assert.ok(Math.abs((monthly.usedPercent ?? 0) - 62) < 1e-9)
  assert.equal(monthly.title, 'Monthly')
  assert.equal(monthly.windowSeconds, 30 * 86_400)
  assert.equal(monthly.resetAt, 1_893_456_000_000)
  assert.equal(monthly.limit, 20)
})

test('normalize: in_overage pins the plan window at 100%', () => {
  const result = normalizeQuotaPayload({
    subscription: { plan: 'Pro', kwh_included: 100, kwh_used: 105, in_overage: true }
  })
  assert.equal(result.inOverage, true)
  assert.equal(result.windows.Pro.usedPercent, 100)
})

test('normalize: blocked allowance pins its window at 100%', () => {
  const result = normalizeQuotaPayload({
    key: { allowance: { spent_usd: 25, limit_usd: 20, period: 'daily', blocked: true } },
    balance: { credits_remaining_usd: 5 }
  })
  assert.equal(result.blocked, true)
  assert.equal(result.windows.daily.usedPercent, 100)
})

test('normalize: effective limit is min(limit, credits + spent)', () => {
  const result = normalizeQuotaPayload({
    key: { allowance: { spent_usd: 12.4, limit_usd: 20, period: 'monthly' } },
    balance: { credits_remaining_usd: 5 }
  })
  const monthly = result.windows.monthly
  assert.equal(monthly.limit, 17.4)
  assert.ok(Math.abs((monthly.usedPercent ?? 0) - (12.4 / 17.4) * 100) < 1e-9)
})

test('normalize: credits-only payload produces a credits_balance window', () => {
  const result = normalizeQuotaPayload({ balance: { credits_remaining_usd: 18.2 } })
  assert.equal(result.planKey, null)
  const credits = result.windows.credits_balance
  assert.equal(credits.valueLabel, '$18.20')
  assert.equal(credits.usedPercent, null)
})

test('normalize: an unusable payload yields no windows', () => {
  assert.equal(Object.keys(normalizeQuotaPayload({}).windows).length, 0)
  assert.equal(Object.keys(normalizeQuotaPayload(null).windows).length, 0)
  assert.equal(Object.keys(normalizeQuotaPayload('nope').windows).length, 0)
})

test('normalize: unknown period falls back to billing_cycle', () => {
  const result = normalizeQuotaPayload({
    key: { allowance: { spent_usd: 1, limit_usd: 10, period: 'fortnight' } }
  })
  const window = result.windows.billing_cycle
  assert.equal(window.title, 'Billing cycle')
  assert.equal(window.windowSeconds, null)
})

test('toTimestamp: epoch seconds, ms, numeric and ISO strings', () => {
  assert.equal(toTimestamp(1_893_456_000), 1_893_456_000_000)
  assert.equal(toTimestamp(1_893_456_000_000), 1_893_456_000_000)
  assert.equal(toTimestamp('1893456000'), 1_893_456_000_000)
  assert.equal(toTimestamp('2030-01-01T00:00:00Z'), Date.parse('2030-01-01T00:00:00Z'))
  assert.equal(toTimestamp(''), null)
  assert.equal(toTimestamp('not a date'), null)
  assert.equal(toTimestamp(undefined), null)
})

test('fetchQuota: success', async () => {
  const snapshot = await fetchQuota('nw_key', {
    fetchImpl: stubFetch(stubResponse(fullPayload)),
    now: () => NOW
  })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.error, null)
  assert.equal(snapshot.fetchedAt, NOW)
  assert.equal(snapshot.configured, true)
  assert.equal(snapshot.creditsRemainingUsd, 18.2)
  assert.ok(snapshot.windows.monthly)
})

test('fetchQuota: 401 names the API key as the problem', async () => {
  const snapshot = await fetchQuota('nw_key', {
    fetchImpl: stubFetch(stubResponse({}, 401)),
    now: () => NOW
  })
  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.error, 'API key rejected — replace it in Settings')
})

test('fetchQuota: 429 carries Retry-After as retryAfterMs', async () => {
  const snapshot = await fetchQuota('nw_key', {
    fetchImpl: stubFetch(stubResponse({}, 429, '30')),
    now: () => NOW
  })
  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.error, 'API error: 429')
  assert.equal(snapshot.retryAfterMs, 30_000)
})

test('fetchQuota: timeout', async () => {
  const failure = Object.assign(new Error('terminated'), { name: 'TimeoutError' })
  const snapshot = await fetchQuota('nw_key', {
    fetchImpl: stubFetch(failure),
    now: () => NOW
  })
  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.error, 'Request timed out')
})

test('fetchQuota: invalid JSON', async () => {
  const failure = Object.assign(new Error('Unexpected token'), { name: 'SyntaxError' })
  const snapshot = await fetchQuota('nw_key', {
    fetchImpl: stubFetch(failure),
    now: () => NOW
  })
  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.error, 'Invalid response from provider')
})

test('fetchQuota: ok response without quota data is an error', async () => {
  const snapshot = await fetchQuota('nw_key', {
    fetchImpl: stubFetch(stubResponse({})),
    now: () => NOW
  })
  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.error, 'No quota data in response')
})

test('fetchQuota: sends the bearer token and identity encoding', async () => {
  let seenInit: { method?: string; headers?: Record<string, string> } | undefined
  const fetchImpl: FetchLike = async (_url, init) => {
    seenInit = init
    return stubResponse(fullPayload)
  }
  await fetchQuota('nw_secret', { fetchImpl })
  assert.equal(seenInit?.method, 'GET')
  assert.equal(seenInit?.headers?.Authorization, 'Bearer nw_secret')
  assert.equal(seenInit?.headers?.['Accept-Encoding'], 'identity')
})

// --- normalizer edge branches ----------------------------------------------

test('normalize: unnamed plan becomes plan_limit', () => {
  const result = normalizeQuotaPayload({ subscription: { kwh_included: 100, kwh_used: 10 } })
  assert.equal(result.planKey, 'plan_limit')
  assert.equal(result.windows.plan_limit.title, 'Plan')
})

test('normalize: zero, negative or missing kWh numbers yield no percent', () => {
  assert.equal(normalizeQuotaPayload({ subscription: { kwh_included: 0, kwh_used: 5 } }).windows.plan_limit.usedPercent, null)
  assert.equal(normalizeQuotaPayload({ subscription: { kwh_included: -5, kwh_used: 5 } }).windows.plan_limit.usedPercent, null)
  assert.equal(normalizeQuotaPayload({ subscription: { kwh_included: 100 } }).windows.plan_limit.usedPercent, null)
})

test('normalize: usage clamps to 0–100 even without the overage flag', () => {
  const over = normalizeQuotaPayload({ subscription: { kwh_included: 100, kwh_used: 150 } })
  assert.equal(over.windows.plan_limit.usedPercent, 100)
  const negative = normalizeQuotaPayload({ subscription: { kwh_included: 100, kwh_used: -10 } })
  assert.equal(negative.windows.plan_limit.usedPercent, 0)
})

test('normalize: numeric strings are accepted', () => {
  const result = normalizeQuotaPayload({
    subscription: { plan: 'Pro', kwh_included: '100', kwh_used: '42.5' },
    balance: { credits_remaining_usd: '18.2' }
  })
  assert.equal(result.windows.Pro.usedPercent, 42.5)
  assert.equal(result.creditsRemainingUsd, 18.2)
})

test('normalize: month and yearly period aliases', () => {
  const month = normalizeQuotaPayload({ key: { allowance: { spent_usd: 1, limit_usd: 10, period: 'month' } } })
  assert.equal(month.windows.monthly.title, 'Monthly')
  assert.equal(month.windows.monthly.windowSeconds, 30 * 86_400)
  const year = normalizeQuotaPayload({ key: { allowance: { spent_usd: 1, limit_usd: 10, period: 'yearly' } } })
  assert.equal(year.windows.billing_cycle.title, 'Billing cycle')
  assert.equal(year.windows.billing_cycle.windowSeconds, 365 * 86_400)
})

test('normalize: effective limit falls back to whichever bound exists', () => {
  const limitOnly = normalizeQuotaPayload({ key: { allowance: { spent_usd: 5, limit_usd: 10 } } })
  assert.equal(limitOnly.windows.billing_cycle.limit, 10)

  const creditsOnly = normalizeQuotaPayload({
    key: { allowance: { spent_usd: 2, period: 'daily' } },
    balance: { credits_remaining_usd: 8 }
  })
  assert.equal(creditsOnly.windows.daily.limit, 8)
  assert.ok(Math.abs((creditsOnly.windows.daily.usedPercent ?? 0) - 25) < 1e-9)

  const neither = normalizeQuotaPayload({ key: { allowance: { period: 'daily' } } })
  assert.equal(neither.windows.daily.usedPercent, null)
})

test('normalize: subscription and allowance windows coexist', () => {
  const result = normalizeQuotaPayload({
    subscription: { plan: 'Pro', kwh_included: 100, kwh_used: 10 },
    key: { allowance: { spent_usd: 1, limit_usd: 10, period: 'daily' } }
  })
  assert.deepEqual(Object.keys(result.windows).sort(), ['Pro', 'daily'])
  assert.equal(result.planKey, 'Pro')
})

test('normalize: kwh_reset_date falls back to current_period_end, then null', () => {
  const fallback = normalizeQuotaPayload({
    subscription: { kwh_included: 100, kwh_used: 1, current_period_end: '2030-06-01T00:00:00Z' }
  })
  assert.equal(fallback.windows.plan_limit.resetAt, Date.parse('2030-06-01T00:00:00Z'))
  const none = normalizeQuotaPayload({ subscription: { kwh_included: 100, kwh_used: 1 } })
  assert.equal(none.windows.plan_limit.resetAt, null)
})

test('toTimestamp: non-finite numbers are rejected', () => {
  assert.equal(toTimestamp(Number.POSITIVE_INFINITY), null)
  assert.equal(toTimestamp(Number.NaN), null)
})

// --- fetchQuota edge branches ----------------------------------------------

test('fetchQuota: other statuses surface the code', async () => {
  const snapshot = await fetchQuota('nw_key', { fetchImpl: stubFetch(stubResponse({}, 403)), now: () => NOW })
  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.error, 'API error: 403')
})

test('fetchQuota: an empty 204 body is an invalid response', async () => {
  const empty204: FetchResponseLike = {
    ok: true,
    status: 204,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input')
    }
  }
  const snapshot = await fetchQuota('nw_key', { fetchImpl: stubFetch(empty204), now: () => NOW })
  assert.equal(snapshot.error, 'Invalid response from provider')
})

test('fetchQuota: Retry-After as an HTTP date', async () => {
  const soon = new Date(Date.now() + 60_000).toUTCString()
  const snapshot = await fetchQuota('nw_key', { fetchImpl: stubFetch(stubResponse({}, 429, soon)), now: () => NOW })
  assert.ok((snapshot.retryAfterMs ?? 0) > 0)
})

test('fetchQuota: negative, garbage or absent Retry-After is ignored', async () => {
  const negative = await fetchQuota('nw_key', { fetchImpl: stubFetch(stubResponse({}, 429, '-5')), now: () => NOW })
  assert.equal(negative.retryAfterMs, null)
  const garbage = await fetchQuota('nw_key', { fetchImpl: stubFetch(stubResponse({}, 429, 'soon-ish')), now: () => NOW })
  assert.equal(garbage.retryAfterMs, null)
  const absent = await fetchQuota('nw_key', { fetchImpl: stubFetch(stubResponse({}, 429)), now: () => NOW })
  assert.equal(absent.retryAfterMs, null)
})
