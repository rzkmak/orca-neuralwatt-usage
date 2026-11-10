import { formatMoney } from './format.ts'
import type { Snapshot, UsageWindow } from './protocol.ts'

export const NEURALWATT_QUOTA_URL = 'https://api.neuralwatt.com/v1/quota'

const DEFAULT_TIMEOUT_MS = 15_000

/** Minimal shape of `fetch`'s response, so tests can stub it. The real Response satisfies it. */
export type FetchResponseLike = {
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  json: () => Promise<unknown>
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<FetchResponseLike>

export type FetchDeps = {
  fetchImpl?: FetchLike
  timeoutMs?: number
  now?: () => number
}

export type NormalizedQuota = {
  windows: Record<string, UsageWindow>
  planKey: string | null
  inOverage: boolean
  blocked: boolean
  creditsRemainingUsd: number | null
}

// 30d month / 365d year are fixed approximations; real calendars vary but the
// window is for UI labels, not billing decisions.
function periodToWindowSeconds(period: string | null): number | null {
  if (period === 'daily') return 86_400
  if (period === 'weekly') return 604_800
  if (period === 'monthly' || period === 'month') return 30 * 86_400
  if (period === 'yearly' || period === 'year') return 365 * 86_400
  return null
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function field(source: Record<string, unknown> | null, key: string): unknown {
  return source === null ? undefined : source[key]
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Accepts epoch seconds, epoch ms, or an ISO string; returns epoch ms. */
export function toTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    if (/^\d+(\.\d+)?$/.test(trimmed)) return toTimestamp(Number(trimmed))
    const parsed = Date.parse(trimmed)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/**
 * Pure normalizer for the NeuralWatt `/v1/quota` payload, ported from
 * openchamber's quota provider. Never throws; an unusable payload simply
 * yields no windows (the caller turns that into an error snapshot).
 */
export function normalizeQuotaPayload(payload: unknown): NormalizedQuota {
  const windows: Record<string, UsageWindow> = {}
  const root = asObject(payload)

  const creditsRemainingUsd = toNumber(field(asObject(field(root, 'balance')), 'credits_remaining_usd'))

  let planKey: string | null = null
  let inOverage = false
  let blocked = false

  // Subscription window: kWh used vs included. The API exposes no window start,
  // so windowSeconds stays null rather than fabricating a guess.
  const subscription = asObject(field(root, 'subscription'))
  if (subscription !== null) {
    inOverage = subscription.in_overage === true
    const kwhIncluded = toNumber(subscription.kwh_included)
    const kwhUsed = toNumber(subscription.kwh_used)
    const plan = toNonEmptyString(subscription.plan)
    const usedPercent = inOverage
      ? 100
      : kwhIncluded !== null && kwhIncluded > 0 && kwhUsed !== null
        ? clampPercent((kwhUsed / kwhIncluded) * 100)
        : null
    const resetAt = toTimestamp(subscription.kwh_reset_date) ?? toTimestamp(subscription.current_period_end)
    planKey = plan ?? 'plan_limit'
    windows[planKey] = {
      key: planKey,
      title: plan ?? 'Plan',
      usedPercent,
      windowSeconds: null,
      resetAt,
      valueLabel: null,
      used: kwhUsed,
      limit: kwhIncluded,
      unit: 'kwh'
    }
  }

  // Allowance window: spend vs cap. The credits wallet is drained by each
  // period's spend before the cap bites, so the effective ceiling is
  // min(limit_usd, credits_remaining_usd + spent_usd).
  const allowance = asObject(field(asObject(field(root, 'key')), 'allowance'))
  if (allowance !== null) {
    blocked = allowance.blocked === true
    const spent = toNumber(allowance.spent_usd)
    const limit = toNumber(allowance.limit_usd)
    const period = toNonEmptyString(allowance.period)
    const effectiveLimit =
      limit !== null && creditsRemainingUsd !== null
        ? Math.min(limit, creditsRemainingUsd + (spent ?? 0))
        : (limit ?? creditsRemainingUsd)
    const usedPercent = blocked
      ? 100
      : spent !== null && effectiveLimit !== null && effectiveLimit > 0
        ? clampPercent((spent / effectiveLimit) * 100)
        : null
    const periodKey =
      period === 'daily' || period === 'weekly' || period === 'monthly' || period === 'month'
        ? period === 'month'
          ? 'monthly'
          : period
        : 'billing_cycle'
    const title = periodKey === 'billing_cycle' ? 'Billing cycle' : periodKey.charAt(0).toUpperCase() + periodKey.slice(1)
    windows[periodKey] = {
      key: periodKey,
      title,
      usedPercent,
      windowSeconds: periodToWindowSeconds(period),
      resetAt: toTimestamp(allowance.reset_at),
      valueLabel: null,
      used: spent,
      limit: effectiveLimit,
      unit: 'usd'
    }
  } else if (creditsRemainingUsd !== null) {
    windows.credits_balance = {
      key: 'credits_balance',
      title: 'Credits',
      usedPercent: null,
      windowSeconds: null,
      resetAt: null,
      valueLabel: `$${formatMoney(creditsRemainingUsd)}`,
      used: null,
      limit: null,
      unit: null
    }
  }

  return { windows, planKey, inOverage, blocked, creditsRemainingUsd }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : null
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now())
}

const failedSnapshot = {
  configured: true,
  error: null as string | null,
  inOverage: false,
  blocked: false,
  creditsRemainingUsd: null as number | null,
  planKey: null as string | null,
  windows: {} as Record<string, UsageWindow>,
  retryAfterMs: null as number | null
}

/**
 * Fetches and normalizes the quota. Never throws: every failure mode becomes a
 * Snapshot with ok: false and a human-readable error (never containing the key).
 */
export async function fetchQuota(apiKey: string, deps: FetchDeps = {}): Promise<Snapshot> {
  const fetchImpl = (deps.fetchImpl ?? fetch) as FetchLike
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)

  try {
    const response = await fetchImpl(NEURALWATT_QUOTA_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity'
      },
      signal: timeoutSignal
    })

    if (!response.ok) {
      return {
        ...failedSnapshot,
        ok: false,
        fetchedAt: now(),
        error:
          response.status === 401
            ? 'API key rejected — replace it in Settings'
            : `API error: ${response.status}`,
        retryAfterMs: parseRetryAfterMs(response.headers?.get('retry-after') ?? null)
      }
    }

    const payload: unknown = await response.json()
    const normalized = normalizeQuotaPayload(payload)
    if (Object.keys(normalized.windows).length === 0) {
      return { ...failedSnapshot, ok: false, fetchedAt: now(), error: 'No quota data in response' }
    }
    return { ...failedSnapshot, ...normalized, ok: true, error: null, fetchedAt: now() }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const message = error instanceof Error ? error.message : 'Request failed'
    return {
      ...failedSnapshot,
      ok: false,
      fetchedAt: now(),
      error:
        timeoutSignal.aborted || name === 'TimeoutError' || name === 'AbortError'
          ? 'Request timed out'
          : name === 'SyntaxError'
            ? 'Invalid response from provider'
            : message === '' ? 'Request failed' : message
    }
  }
}
