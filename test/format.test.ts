import test from 'node:test'
import assert from 'node:assert/strict'
import { formatMoney, formatNumber, formatRelative, formatUntil } from '../src/format.ts'

const NOW = 1_700_000_000_000

test('formatMoney: two decimals, trimmed when whole', () => {
  assert.equal(formatMoney(18.2), '18.20')
  assert.equal(formatMoney(18), '18')
  assert.equal(formatMoney(18.256), '18.26')
  assert.equal(formatMoney(0), '0')
  assert.equal(formatMoney(Number.NaN), '0')
})

test('formatNumber: trims to two decimals', () => {
  assert.equal(formatNumber(100), '100')
  assert.equal(formatNumber(42.5), '42.5')
  assert.equal(formatNumber(42.456), '42.46')
})

test('formatRelative buckets', () => {
  assert.equal(formatRelative(NOW - 10_000, NOW), 'just now')
  assert.equal(formatRelative(NOW - 120_000, NOW), '2m ago')
  assert.equal(formatRelative(NOW - 7_200_000, NOW), '2h ago')
  assert.equal(formatRelative(NOW - 3 * 86_400_000, NOW), '3d ago')
  assert.equal(formatRelative(NOW + 60_000, NOW), 'just now')
})

test('formatUntil buckets', () => {
  assert.equal(formatUntil(null, NOW), null)
  assert.equal(formatUntil(NOW - 1_000, NOW), 'reset overdue')
  assert.equal(formatUntil(NOW + 30_000, NOW), 'resets in 30s')
  assert.equal(formatUntil(NOW + 11 * 3_600_000, NOW), 'resets in 11h')
  assert.equal(formatUntil(NOW + 3 * 86_400_000, NOW), 'resets in 3d')
})

test('formatMoney: negatives and large values', () => {
  assert.equal(formatMoney(-12.5), '-12.50')
  assert.equal(formatMoney(-18), '-18')
  assert.equal(formatMoney(1_000_000), '1000000')
})

test('formatNumber: non-finite input', () => {
  assert.equal(formatNumber(Number.NaN), '0')
  assert.equal(formatNumber(Number.POSITIVE_INFINITY), '0')
})

test('formatRelative: bucket boundaries round up', () => {
  assert.equal(formatRelative(NOW - 45_000, NOW), '1m ago')
  assert.equal(formatRelative(NOW - 90 * 60_000, NOW), '2h ago')
  assert.equal(formatRelative(NOW - 36 * 3_600_000, NOW), '2d ago')
})

test('formatUntil: bucket boundaries round up', () => {
  assert.equal(formatUntil(NOW + 89_000, NOW), 'resets in 89s')
  assert.equal(formatUntil(NOW + 90_000, NOW), 'resets in 2m')
  assert.equal(formatUntil(NOW + 90 * 60_000, NOW), 'resets in 2h')
  assert.equal(formatUntil(NOW + 36 * 3_600_000, NOW), 'resets in 2d')
})
