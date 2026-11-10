import test from 'node:test'
import assert from 'node:assert/strict'
import type { OrcaWorkerApi } from 'orca/worker'
import activate, { deactivate } from '../src/main.ts'
import { configureOpenCodeExport } from '../src/opencodeauth.ts'
import type { PluginSettings, Snapshot } from '../src/protocol.ts'
import { MINUTE_MS } from '../src/schedule.ts'

// Never shell out to the real `opencode` binary from worker tests; individual
// tests reconfigure this with a fake runner and restore it afterwards.
configureOpenCodeExport(async () => {
  throw new Error('auth export disabled in worker tests')
}, 0)

const QUOTA_URL = 'https://api.neuralwatt.com/v1/quota'

const FULL_PAYLOAD = {
  subscription: { plan: 'Pro', kwh_included: 100, kwh_used: 42.5, kwh_reset_date: '2030-01-01T00:00:00Z' },
  key: { allowance: { spent_usd: 12.4, limit_usd: 20, period: 'monthly', reset_at: 1_893_456_000, blocked: false } },
  balance: { credits_remaining_usd: 18.2 }
}

const CREDENTIAL_BODY = { neuralwatt: { type: 'api', key: 'nw_from_opencode' } }

/** Lets pending async chains (host calls, fetch stubs, timers) settle. */
async function drain(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

type HostState = {
  updates: Array<{ id: string; text?: string; tone?: string; tooltip?: string }>
  logs: string[]
  storage: Map<string, unknown>
  secrets: Map<string, string>
  secretsFail: boolean
  settingsListeners: Array<(change: { key: string }) => void>
  commands: Map<string, () => void>
  statusFail: boolean
  settingsFail: boolean
  storageGetThrows: boolean
  storageSetThrows: boolean
  settings: PluginSettings
}

function makeHost(settingsOverrides: Partial<PluginSettings> = {}): { orca: OrcaWorkerApi; state: HostState } {
  const state: HostState = {
    updates: [],
    logs: [],
    storage: new Map(),
    secrets: new Map(),
    secretsFail: false,
    settingsListeners: [],
    commands: new Map(),
    statusFail: false,
    settingsFail: false,
    storageGetThrows: false,
    storageSetThrows: false,
    settings: {
      apiKey: '',
      refreshMinutes: 5,
      display: 'both',
      openCodeUrl: '',
      openCodePassword: '',
      ...settingsOverrides
    }
  }
  const orca = {
    settings: {
      get: async () => {
        if (state.settingsFail) throw new Error('settings unavailable')
        return { ...state.settings }
      },
      onDidChange: (listener: (change: { key: string }) => void) => {
        state.settingsListeners.push(listener)
        return {
          dispose: () => {
            const index = state.settingsListeners.indexOf(listener)
            if (index >= 0) state.settingsListeners.splice(index, 1)
          }
        }
      }
    },
    storage: {
      get: async (key: string) => {
        if (state.storageGetThrows) throw new Error('storage unavailable')
        return state.storage.has(key) ? state.storage.get(key) : null
      },
      set: async (key: string, value: unknown) => {
        if (state.storageSetThrows) throw new Error('disk full')
        await state.storage.set(key, value)
      }
    },
    secrets: {
      get: async (name: string) => {
        if (state.secretsFail) throw new Error('secret store unavailable')
        return state.secrets.has(name) ? state.secrets.get(name) ?? null : null
      },
      set: async (name: string, value: string) => {
        if (state.secretsFail) throw new Error('secret store unavailable')
        state.secrets.set(name, value)
      },
      delete: async (name: string) => {
        if (state.secretsFail) throw new Error('secret store unavailable')
        state.secrets.delete(name)
      }
    },
    host: {
      call: async (method: string, params: unknown) => {
        if (method !== 'statusBar.update') throw new Error(`unexpected host call: ${method}`)
        if (state.statusFail) throw new Error('statusBar unavailable')
        state.updates.push(params as { id: string; text?: string; tone?: string; tooltip?: string })
        return { ok: true }
      }
    },
    commands: {
      register: (id: string, handler: () => void) => {
        state.commands.set(id, handler)
        return { dispose: () => state.commands.delete(id) }
      }
    },
    log: (message: string) => {
      state.logs.push(message)
    }
  }
  const settingsApi = {
    get: orca.settings.get,
    set: async (key: string, value: unknown) => {
      ;(state.settings as unknown as Record<string, unknown>)[key] = value
      for (const listener of [...state.settingsListeners]) listener({ key })
    },
    onDidChange: orca.settings.onDidChange
  }
  ;(orca as unknown as { settings: unknown }).settings = settingsApi
  return { orca: orca as unknown as OrcaWorkerApi, state }
}

type FetchRoute = (url: string) => { status?: number; body?: unknown } | undefined

function stubFetch(route: FetchRoute): { calls: Array<{ url: string; authorization: string | undefined }>; quotaCalls(): number; restore(): void } {
  const calls: Array<{ url: string; authorization: string | undefined }> = []
  const original = globalThis.fetch
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: href, authorization: headers.Authorization })
    const hit = route(href)
    if (hit === undefined) throw new Error(`unexpected fetch: ${href}`)
    const status = hit.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => hit.body
    }
  }) as unknown as typeof fetch
  globalThis.fetch = impl
  return {
    calls,
    quotaCalls: () => calls.filter((call) => call.url === QUOTA_URL).length,
    restore: () => {
      globalThis.fetch = original
    }
  }
}

function quotaRoute(getStatus: () => number): FetchRoute {
  return (url) => {
    if (url === QUOTA_URL) return { status: getStatus(), body: FULL_PAYLOAD }
    return undefined
  }
}

function cachedSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    ok: true,
    configured: true,
    error: null,
    fetchedAt: Date.now() - 60_000,
    inOverage: false,
    blocked: false,
    creditsRemainingUsd: 5,
    planKey: null,
    retryAfterMs: null,
    windows: {
      monthly: { key: 'monthly', title: 'Monthly', usedPercent: 10, windowSeconds: null, resetAt: null, valueLabel: null, used: 1, limit: 10, unit: 'usd' }
    },
    ...overrides
  }
}

test('worker: activate paints the cached snapshot, then the poll refreshes it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  state.storage.set('snapshot', cachedSnapshot())
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()

    // Cache is painted before any network activity.
    assert.equal(state.updates[0]?.text, 'NeuralWatt Balance 10% · $5')
    assert.equal(stub.quotaCalls(), 0)

    t.mock.timers.tick(0)
    await drain()

    assert.equal(stub.quotaCalls(), 1)
    assert.equal(stub.calls[0]?.authorization, 'Bearer nw_key')
    const last = state.updates[state.updates.length - 1]
    assert.equal(last?.text, 'NeuralWatt Balance 62% · $18.20')
    assert.equal(last?.tone, 'neutral')
    const stored = state.storage.get('snapshot') as Snapshot
    assert.equal(stored.ok, true)
    assert.ok(stored.windows.Pro)
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: no key anywhere paints the set-key state and never fetches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost()
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()

    assert.equal(state.updates[0]?.text, 'NeuralWatt Balance · set key')
    assert.equal(state.updates[0]?.tone, 'neutral')
    assert.equal(stub.quotaCalls(), 0)
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: a borrowed OpenCode key drives the quota fetch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ openCodeUrl: 'http://127.0.0.1:4096' })
  const stub = stubFetch((url) => {
    if (url === QUOTA_URL) return { status: 200, body: FULL_PAYLOAD }
    if (url === 'http://127.0.0.1:4096/api/credential') return { status: 200, body: CREDENTIAL_BODY }
    return undefined
  })
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()

    const quotaCall = stub.calls.find((call) => call.url === QUOTA_URL)
    assert.equal(quotaCall?.authorization, 'Bearer nw_from_opencode')
    const last = state.updates[state.updates.length - 1]
    assert.equal(last?.text, 'NeuralWatt Balance 62% · $18.20')
    assert.match(last?.tooltip ?? '', /^NeuralWatt · key from OpenCode\n/)
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: the status bar command refreshes immediately, debounced with a trailing pass', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()
    assert.equal(stub.quotaCalls(), 1)

    const command = state.commands.get('neuralwatt.refresh')
    assert.ok(command)
    command() // starts a manual refresh
    command() // while in flight → queued as one trailing refresh
    await drain()
    t.mock.timers.tick(0)
    await drain()

    // 1 initial + 1 manual + 1 trailing
    assert.equal(stub.quotaCalls(), 3)
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: replacing the API key in Settings refetches with the new key', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'key_a' })
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()
    assert.equal(stub.calls.at(-1)?.authorization, 'Bearer key_a')

    state.settings.apiKey = 'key_b'
    for (const listener of state.settingsListeners) listener({ key: 'apiKey' })
    await drain()

    assert.equal(stub.quotaCalls(), 2)
    assert.equal(stub.calls.at(-1)?.authorization, 'Bearer key_b')
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: changing the display setting repaints from cache without refetching', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()
    assert.equal(stub.quotaCalls(), 1)

    state.settings.display = 'credits'
    for (const listener of state.settingsListeners) listener({ key: 'display' })
    await drain()

    assert.equal(stub.quotaCalls(), 1)
    assert.equal(state.updates.at(-1)?.text, 'NeuralWatt Balance $18.20')
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: status bar failures are logged, never thrown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  state.statusFail = true
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()

    assert.ok(state.logs.filter((line) => line.includes('status bar update failed')).length >= 2)
    assert.equal(stub.quotaCalls(), 1) // the loop kept polling regardless
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: a failed quota fetch keeps the last good paint and backs off', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  let status = 200
  const stub = stubFetch(quotaRoute(() => status))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()
    assert.equal(state.updates.at(-1)?.text, 'NeuralWatt Balance 62% · $18.20')

    status = 500
    t.mock.timers.tick(10 * MINUTE_MS) // past the jittered 5-minute interval
    await drain()
    assert.equal(stub.quotaCalls(), 2)
    const failing = state.updates.at(-1)
    assert.equal(failing?.text, 'NeuralWatt Balance 62% · $18.20') // last good text survives
    assert.match(failing?.tooltip ?? '', /⚠ API error: 500/)

    t.mock.timers.tick(30 * MINUTE_MS) // past the 2× backoff
    await drain()
    assert.equal(stub.quotaCalls(), 3)
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: storage read failures fall back to the initial paint', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  state.storageGetThrows = true
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    assert.equal(state.updates[0]?.text, 'NeuralWatt Balance …')

    t.mock.timers.tick(0)
    await drain()
    assert.equal(stub.quotaCalls(), 1)
    assert.equal(state.updates.at(-1)?.text, 'NeuralWatt Balance 62% · $18.20')
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: storage write failures are logged and the loop continues', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  state.storageSetThrows = true
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()

    assert.ok(state.logs.some((line) => line.includes('refresh failed: disk full')))
    assert.equal(stub.quotaCalls(), 1)
    // The cycle aborted before painting, but the loop is alive and scheduled again.
    t.mock.timers.tick(30 * MINUTE_MS)
    await drain()
    assert.equal(stub.quotaCalls(), 2)
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: settings read failures fall back to defaults', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost()
  state.settingsFail = true
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()

    assert.ok(state.logs.some((line) => line.includes('could not read settings: settings unavailable')))
    assert.equal(state.updates[0]?.text, 'NeuralWatt Balance · set key')
    assert.equal(stub.quotaCalls(), 0)
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: clearing the entry field does not remove the stored secret', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()
    assert.equal(state.secrets.get('apiKey'), 'nw_key')

    // The field is entry-only: blanking it is not removal. Removing the stored
    // key is the explicit 'NeuralWatt: Forget stored API key' command.
    state.settings.apiKey = ''
    for (const listener of state.settingsListeners) listener({ key: 'apiKey' })
    await drain()

    assert.equal(state.secrets.get('apiKey'), 'nw_key')
    assert.equal(stub.quotaCalls(), 1)
    assert.equal(state.updates.at(-1)?.text, 'NeuralWatt Balance 62% · $18.20')
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: a key from `opencode auth export` drives the quota fetch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  configureOpenCodeExport(async () => JSON.stringify([
    { id: 'c2', integrationID: 'neuralwatt', active: true, value: { type: 'key', key: 'nw_exported' } }
  ]), 0)
  const { orca, state } = makeHost() // no apiKey, no server URL — pure export tier
  const stub = stubFetch((url) => {
    if (url === QUOTA_URL) return { status: 200, body: FULL_PAYLOAD }
    return undefined
  })
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()

    const quotaCall = stub.calls.find((call) => call.url === QUOTA_URL)
    assert.equal(quotaCall?.authorization, 'Bearer nw_exported')
    const last = state.updates[state.updates.length - 1]
    assert.equal(last?.text, 'NeuralWatt Balance 62% · $18.20')
    assert.match(last?.tooltip ?? '', /^NeuralWatt · key from OpenCode\n/)
  } finally {
    configureOpenCodeExport(async () => {
      throw new Error('auth export disabled in worker tests')
    }, 0)
    await deactivate()
    stub.restore()
  }
})

test('worker: a pasted key is migrated into the encrypted store and the plain field blanked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_plain' })
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()

    // The key lives in the secret store now…
    assert.equal(state.secrets.get('apiKey'), 'nw_plain')
    // …the plain settings field was blanked (no plaintext at rest)…
    assert.equal(state.settings.apiKey, '')
    // …the fetch used it…
    assert.equal(stub.calls.at(-1)?.authorization, 'Bearer nw_plain')
    // …and the cached snapshot never contains key material.
    assert.ok(!JSON.stringify(state.storage.get('snapshot') ?? {}).includes('nw_plain'))
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: the stored secret keeps working with the settings field empty', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: '' })
  state.secrets.set('apiKey', 'nw_secret') // survives "restarts" — encrypted at rest
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()

    assert.equal(stub.calls.at(-1)?.authorization, 'Bearer nw_secret')
    assert.equal(state.updates.at(-1)?.text, 'NeuralWatt Balance 62% · $18.20')
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: a replaced key overwrites the stored secret', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()
    assert.equal(state.secrets.get('apiKey'), 'nw_key')

    state.settings.apiKey = 'key_b'
    for (const listener of state.settingsListeners) listener({ key: 'apiKey' })
    await drain()

    assert.equal(state.secrets.get('apiKey'), 'key_b')
    assert.equal(state.settings.apiKey, '')
    assert.equal(stub.calls.at(-1)?.authorization, 'Bearer key_b')
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: an unavailable secret store keeps the key in settings as fallback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_plain' })
  state.secretsFail = true
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()

    assert.equal(state.secrets.size, 0)
    assert.equal(state.settings.apiKey, 'nw_plain') // plaintext fallback, flagged in the log
    assert.ok(state.logs.some((line) => line.includes('could not store "apiKey" encrypted')))
    assert.equal(stub.calls.at(-1)?.authorization, 'Bearer nw_plain') // still functional
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: a ?password= in the server URL moves into the secret store', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ openCodeUrl: 'http://127.0.0.1:4096/?password=urlpw' })
  const stub = stubFetch((url) => {
    if (url === QUOTA_URL) return { status: 200, body: FULL_PAYLOAD }
    if (url === 'http://127.0.0.1:4096/api/credential') return { status: 200, body: CREDENTIAL_BODY }
    return undefined
  })
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()

    assert.equal(state.secrets.get('openCodePassword'), 'urlpw')
    assert.equal(state.settings.openCodeUrl, 'http://127.0.0.1:4096/')
    const credentialCall = stub.calls.find((call) => call.url === 'http://127.0.0.1:4096/api/credential')
    assert.equal(credentialCall?.authorization, 'Bearer urlpw')
    assert.equal(state.updates.at(-1)?.text, 'NeuralWatt Balance 62% · $18.20')
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: the forget command clears stored credentials', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()
    assert.equal(state.secrets.get('apiKey'), 'nw_key')

    const command = state.commands.get('neuralwatt.forgetKeys')
    assert.ok(command)
    command()
    await drain()

    assert.equal(state.secrets.has('apiKey'), false)
    assert.equal(state.secrets.has('openCodePassword'), false)
    // No key from any tier (export disabled in tests) → back to the set-key state.
    assert.equal(state.updates.at(-1)?.text, 'NeuralWatt Balance · set key')
    assert.equal(stub.quotaCalls(), 1) // no fetch without a key
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: an OpenCode server password pasted in settings moves into the secret store', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ openCodeUrl: 'http://127.0.0.1:4096', openCodePassword: 'settingpw' })
  const stub = stubFetch((url) => {
    if (url === QUOTA_URL) return { status: 200, body: FULL_PAYLOAD }
    if (url === 'http://127.0.0.1:4096/api/credential') return { status: 200, body: CREDENTIAL_BODY }
    return undefined
  })
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()

    assert.equal(state.secrets.get('openCodePassword'), 'settingpw')
    assert.equal(state.settings.openCodePassword, '')
    const credentialCall = stub.calls.find((call) => call.url === 'http://127.0.0.1:4096/api/credential')
    assert.equal(credentialCall?.authorization, 'Bearer settingpw')
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: an unparseable server URL with password= is left alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ openCodeUrl: 'not a url?password=x' })
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()

    assert.equal(state.secrets.size, 0) // nothing could be extracted
    assert.equal(state.settings.openCodeUrl, 'not a url?password=x') // untouched
    assert.equal(state.updates[0]?.text, 'NeuralWatt Balance · set key')
    assert.equal(stub.quotaCalls(), 0)
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: forget logs and continues when the secret store fails', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  state.secretsFail = true
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()

    const command = state.commands.get('neuralwatt.forgetKeys')
    assert.ok(command)
    command()
    await drain()

    assert.ok(state.logs.some((line) => line.includes('could not clear stored credentials')))
    // The plaintext fallback is removed too — nothing resolvable remains.
    assert.equal(state.settings.apiKey, '')
    assert.equal(state.updates.at(-1)?.text, 'NeuralWatt Balance · set key')
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: forget falls back to the OpenCode tier when it still supplies a key', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  configureOpenCodeExport(async () => JSON.stringify([
    { id: 'c2', integrationID: 'neuralwatt', active: true, value: { type: 'key', key: 'nw_exported' } }
  ]), 0)
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()
    assert.equal(stub.calls.at(-1)?.authorization, 'Bearer nw_key')

    const command = state.commands.get('neuralwatt.forgetKeys')
    assert.ok(command)
    command()
    await drain()

    // The stored secret is gone, but the export tier still supplies a key.
    assert.equal(state.secrets.has('apiKey'), false)
    assert.equal(stub.quotaCalls(), 2)
    assert.equal(stub.calls.at(-1)?.authorization, 'Bearer nw_exported')
  } finally {
    configureOpenCodeExport(async () => {
      throw new Error('auth export disabled in worker tests')
    }, 0)
    await deactivate()
    stub.restore()
  }
})

test('worker: a settings change that leaves no key anywhere paints the set-key state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()

    // The stored secret disappears out of band (e.g. cleared in the Keychain),
    // and the entry field is empty: nothing resolves any more.
    state.secrets.delete('apiKey')
    state.settings.apiKey = ''
    for (const listener of state.settingsListeners) listener({ key: 'apiKey' })
    await drain()

    assert.equal(stub.quotaCalls(), 1)
    assert.equal(state.updates.at(-1)?.text, 'NeuralWatt Balance · set key')
  } finally {
    await deactivate()
    stub.restore()
  }
})

test('worker: deactivate stops the loop and disposes registrations', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { orca, state } = makeHost({ apiKey: 'nw_key' })
  const stub = stubFetch(quotaRoute(() => 200))
  try {
    await activate(orca)
    await drain()
    t.mock.timers.tick(0)
    await drain()
    assert.equal(stub.quotaCalls(), 1)
    assert.equal(state.commands.has('neuralwatt.refresh'), true)
    assert.equal(state.settingsListeners.length, 1)

    await deactivate()
    await drain()
    t.mock.timers.tick(60 * MINUTE_MS)
    await drain()

    assert.equal(stub.quotaCalls(), 1) // no further polls
    assert.equal(state.commands.size, 0)
    assert.equal(state.settingsListeners.length, 0)
  } finally {
    stub.restore()
  }
})
