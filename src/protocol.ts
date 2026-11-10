/** Colour of a status bar item, as accepted by `statusBar.update`. */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

/** What the status bar text shows. */
export type DisplayMode = 'percent' | 'credits' | 'both'

/**
 * One usage window, normalized from the NeuralWatt quota response.
 * Every field is always present (null where unknown) so a snapshot survives
 * JSON.stringify round-trips through `storage` losslessly and is assignable
 * to the host's `JsonValue`.
 */
export type UsageWindow = {
  /** 'daily' | 'weekly' | 'monthly' | 'billing_cycle' | 'credits_balance' | plan name | 'plan_limit' */
  key: string
  /** Plan name or period label, shown in the tooltip. */
  title: string
  /** 0–100, or null when the response does not expose enough to compute it. */
  usedPercent: number | null
  /** Fixed approximation from the allowance period; null for the plan window. */
  windowSeconds: number | null
  /** Epoch ms, or null when unknown. */
  resetAt: number | null
  /** Ready-made label, e.g. "$18.20" for the credits-only window; null otherwise. */
  valueLabel: string | null
  /** Raw used amount in window units (kWh or USD). */
  used: number | null
  /** Raw effective limit in window units. */
  limit: number | null
  unit: 'kwh' | 'usd' | null
}

/** The last answer from the NeuralWatt quota API, success or failure. */
export type Snapshot = {
  ok: boolean
  /** An apiKey setting is present (always true from fetchQuota; the worker checks the key itself). */
  configured: boolean
  /** Human-readable, safe to show; never contains the API key. */
  error: string | null
  /** Epoch ms of the fetch attempt. */
  fetchedAt: number
  inOverage: boolean
  blocked: boolean
  creditsRemainingUsd: number | null
  /** Key of the subscription plan window in `windows`, when present. */
  planKey: string | null
  windows: Record<string, UsageWindow>
  /** From a 429 Retry-After header, in ms; null otherwise. */
  retryAfterMs: number | null
}

/** Plugin settings as declared in `contributes.settings`. */
export type PluginSettings = {
  apiKey: string
  refreshMinutes: number
  display: DisplayMode
  /** Optional running OpenCode server to borrow the NeuralWatt key from. */
  openCodeUrl: string
  openCodePassword: string
}

/** Where the API key the worker uses came from. */
export type KeySource = 'setting' | 'opencode'

/** What the worker paints into the status bar item. */
export type StatusBarPaint = {
  text: string
  tone: Tone
  tooltip: string
}

/** Type guard for snapshots read back from `storage` (they went through JSON). */
export function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.ok === 'boolean' &&
    typeof candidate.fetchedAt === 'number' &&
    typeof candidate.windows === 'object' &&
    candidate.windows !== null
  )
}
