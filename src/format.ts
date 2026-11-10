/** "$18.20", "$18" for whole dollars. */
export function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 100) / 100
  if (Object.is(rounded, -0)) return '0'
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

/** "100", "42.5" — up to two decimals, no forced padding. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return String(Math.round(value * 100) / 100)
}

/** "just now", "2m ago", "3h ago", "5d ago". */
export function formatRelative(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** "resets in 3d", "resets in 11h", "reset overdue"; null when resetAt is unknown. */
export function formatUntil(resetAt: number | null, now: number = Date.now()): string | null {
  if (resetAt === null) return null
  const seconds = Math.round((resetAt - now) / 1000)
  if (seconds <= 0) return 'reset overdue'
  if (seconds < 90) return `resets in ${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `resets in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `resets in ${hours}h`
  return `resets in ${Math.round(hours / 24)}d`
}
