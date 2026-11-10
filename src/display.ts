import { formatMoney, formatNumber, formatRelative, formatUntil } from './format.ts'
import type { KeySource, PluginSettings, Snapshot, StatusBarPaint, Tone, UsageWindow } from './protocol.ts'

export function unconfiguredPaint(): StatusBarPaint {
  return {
    text: 'NeuralWatt Balance · set key',
    tone: 'neutral',
    tooltip:
      'Add your NeuralWatt API key in Settings → Plugins → NeuralWatt Usage, or configure an OpenCode server below it to borrow the key OpenCode uses.'
  }
}

export function initialPaint(hasApiKey: boolean): StatusBarPaint {
  return hasApiKey
    ? { text: 'NeuralWatt Balance …', tone: 'neutral', tooltip: 'Fetching NeuralWatt usage…' }
    : unconfiguredPaint()
}

/**
 * Picks what the status bar shows for the latest fetch attempt.
 * `lastGood` (the newest ok snapshot, from cache or this session) keeps the
 * bar useful while the API is failing. `keySource` only labels the tooltip.
 */
export function paintFor(
  settings: PluginSettings,
  snapshot: Snapshot,
  lastGood: Snapshot | null,
  keySource: KeySource = 'setting'
): StatusBarPaint {
  if (settings.apiKey === '') return unconfiguredPaint()
  if (snapshot.ok) return paintUsage(settings, snapshot, keySource)
  if (lastGood !== null && lastGood.ok) {
    const base = paintUsage(settings, lastGood, keySource)
    return {
      ...base,
      tooltip: `${base.tooltip}\n⚠ ${snapshot.error || 'Request failed'} · updated ${formatRelative(lastGood.fetchedAt)}`
    }
  }
  return {
    text: 'NeuralWatt Balance · offline',
    tone: 'warning',
    tooltip: `${snapshot.error || 'Request failed'}\nClick to retry.`
  }
}

function paintUsage(settings: PluginSettings, snapshot: Snapshot, keySource: KeySource): StatusBarPaint {
  const over = snapshot.inOverage || snapshot.blocked
  const percent = primaryPercent(snapshot)
  const tone: Tone = over ? 'danger' : toneFor(percent)
  const text = over ? 'NeuralWatt Balance · over' : statusText(settings, snapshot, percent)
  const tooltip = `${tooltipFor(snapshot, keySource)}\nUpdated ${formatRelative(snapshot.fetchedAt)}`
  return { text, tone, tooltip }
}

/** The spend-cap window bites first; the kWh plan window is the fallback. */
function primaryWindow(snapshot: Snapshot): UsageWindow | null {
  const windows = snapshot.windows
  const allowance = windows.daily ?? windows.weekly ?? windows.monthly ?? windows.billing_cycle
  if (allowance !== undefined) return allowance
  return snapshot.planKey !== null ? (windows[snapshot.planKey] ?? null) : null
}

function primaryPercent(snapshot: Snapshot): number | null {
  return primaryWindow(snapshot)?.usedPercent ?? null
}

function toneFor(percent: number | null): Tone {
  if (percent === null) return 'neutral'
  if (percent >= 90) return 'danger'
  if (percent >= 75) return 'warning'
  return 'neutral'
}

function statusText(settings: PluginSettings, snapshot: Snapshot, percent: number | null): string {
  const parts: string[] = []
  const wantsPercent = settings.display === 'percent' || settings.display === 'both'
  const wantsCredits = settings.display === 'credits' || settings.display === 'both'
  if (wantsPercent && percent !== null) parts.push(`${Math.round(percent)}%`)
  if (wantsCredits && snapshot.creditsRemainingUsd !== null) parts.push(`$${formatMoney(snapshot.creditsRemainingUsd)}`)
  return parts.length > 0 ? `NeuralWatt Balance ${parts.join(' · ')}` : 'NeuralWatt Balance'
}

function tooltipFor(snapshot: Snapshot, keySource: KeySource): string {
  const heading = keySource === 'opencode' ? 'NeuralWatt · key from OpenCode' : 'NeuralWatt'
  const lines = [heading]
  for (const key of Object.keys(snapshot.windows)) {
    const window = snapshot.windows[key]
    // The credits line below already covers the balance-only window.
    if (key === 'credits_balance' || window === undefined) continue
    lines.push(windowLine(window))
  }
  if (snapshot.creditsRemainingUsd !== null) lines.push(`Credits: $${formatMoney(snapshot.creditsRemainingUsd)}`)
  return lines.join('\n')
}

function windowLine(window: UsageWindow): string {
  const parts: string[] = []
  if (
    window.usedPercent !== null &&
    window.used != null &&
    window.limit != null &&
    window.limit > 0
  ) {
    parts.push(
      window.unit === 'usd'
        ? `$${formatMoney(window.used)} of $${formatMoney(window.limit)}`
        : `${Math.round(window.usedPercent)}% of ${formatNumber(window.limit)} kWh`
    )
  } else if (window.usedPercent !== null) {
    parts.push(`${Math.round(window.usedPercent)}%`)
  } else if (window.valueLabel !== null) {
    parts.push(window.valueLabel)
  }
  const reset = formatUntil(window.resetAt)
  if (reset !== null) parts.push(reset)
  return parts.length > 0 ? `${window.title}: ${parts.join(' · ')}` : window.title
}
