import test from 'node:test'
import assert from 'node:assert/strict'
import { isSnapshot } from '../src/protocol.ts'
import { asDisplayMode, clamp, normalizeRawSettings } from '../src/settings.ts'

const validSnapshot = {
  ok: true,
  configured: true,
  error: null,
  fetchedAt: 1_700_000_000_000,
  inOverage: false,
  blocked: false,
  creditsRemainingUsd: 18.2,
  planKey: 'Pro',
  windows: {},
  retryAfterMs: null
}

test('isSnapshot: accepts round-tripped snapshot JSON', () => {
  assert.equal(isSnapshot(validSnapshot), true)
  assert.equal(isSnapshot(JSON.parse(JSON.stringify(validSnapshot))), true)
  assert.equal(isSnapshot({ ...validSnapshot, extra: 'ignored' }), true)
})

test('isSnapshot: rejects junk from storage', () => {
  assert.equal(isSnapshot(null), false)
  assert.equal(isSnapshot(undefined), false)
  assert.equal(isSnapshot('snapshot'), false)
  assert.equal(isSnapshot([]), false)
  assert.equal(isSnapshot({}), false)
  assert.equal(isSnapshot({ ...validSnapshot, ok: 'yes' }), false)
  assert.equal(isSnapshot({ ...validSnapshot, fetchedAt: 'recently' }), false)
  assert.equal(isSnapshot({ ...validSnapshot, windows: null }), false)
  assert.equal(isSnapshot({ ...validSnapshot, windows: 'none' }), false)
})

test('clamp', () => {
  assert.equal(clamp(5, 1, 60), 5)
  assert.equal(clamp(0, 1, 60), 1)
  assert.equal(clamp(100, 1, 60), 60)
})

test('asDisplayMode: known values pass, everything else is both', () => {
  assert.equal(asDisplayMode('percent'), 'percent')
  assert.equal(asDisplayMode('credits'), 'credits')
  assert.equal(asDisplayMode('both'), 'both')
  assert.equal(asDisplayMode('percent ' as unknown), 'both')
  assert.equal(asDisplayMode(undefined), 'both')
  assert.equal(asDisplayMode(42), 'both')
})

test('normalizeRawSettings: declared defaults apply', () => {
  assert.deepEqual(normalizeRawSettings({}), {
    apiKey: '',
    refreshMinutes: 5,
    display: 'both',
    openCodeUrl: '',
    openCodePassword: ''
  })
})

test('normalizeRawSettings: trims strings and clamps the interval', () => {
  const raw = {
    apiKey: '  nw_key  ',
    refreshMinutes: 0,
    display: 'percent',
    openCodeUrl: ' http://127.0.0.1:4096/?password=pw ',
    openCodePassword: '  '
  }
  const settings = normalizeRawSettings(raw)
  assert.equal(settings.apiKey, 'nw_key')
  assert.equal(settings.refreshMinutes, 1)
  assert.equal(settings.display, 'percent')
  assert.equal(settings.openCodeUrl, 'http://127.0.0.1:4096/?password=pw')
  assert.equal(settings.openCodePassword, '')
})

test('normalizeRawSettings: wrong types fall back to defaults', () => {
  const settings = normalizeRawSettings({
    apiKey: 42,
    refreshMinutes: 'soon',
    display: true,
    openCodeUrl: ['http://x'],
    openCodePassword: {}
  })
  assert.equal(settings.apiKey, '')
  assert.equal(settings.refreshMinutes, 5)
  assert.equal(settings.display, 'both')
  assert.equal(settings.openCodeUrl, '')
  assert.equal(settings.openCodePassword, '')
})

test('normalizeRawSettings: non-finite numbers use the default interval', () => {
  assert.equal(normalizeRawSettings({ refreshMinutes: Number.NaN }).refreshMinutes, 5)
  assert.equal(normalizeRawSettings({ refreshMinutes: Number.POSITIVE_INFINITY }).refreshMinutes, 5)
  assert.equal(normalizeRawSettings({ refreshMinutes: 30 }).refreshMinutes, 30)
})
