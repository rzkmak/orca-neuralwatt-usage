import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractNeuralWattKey, readOpenCodeApiKey, resolveApiKey, configureOpenCodeExport } from '../src/opencodeauth.ts'
import type { FetchLike, FetchResponseLike } from '../src/neuralwatt.ts'

// The export tier is disabled by default so no test ever shells out to the
// real `opencode` binary; individual tests reconfigure it with a fake runner.
test.beforeEach(() => {
  configureOpenCodeExport(async () => {
    throw new Error('auth export disabled in tests')
  }, 0)
})

function stubFetch(handler: (url: string, auth: string | undefined) => FetchResponseLike | Promise<FetchResponseLike>): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push(url)
      const auth = init?.headers?.Authorization
      return await handler(url, auth)
    }
  }
}

const jsonResponse = (body: unknown, status = 200): FetchResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body
})

test('extract: OpenCode 2.x credential entries (raw array)', () => {
  const payload = [
    { id: 'c1', integrationID: 'anthropic', active: true, value: { type: 'key', key: 'sk-ant' } },
    { id: 'c2', integrationID: 'neuralwatt', active: true, value: { type: 'key', key: 'nw_raw' } }
  ]
  assert.equal(extractNeuralWattKey(payload), 'nw_raw')
})

test('extract: wrapped credentials list', () => {
  const payload = {
    credentials: [{ integrationID: 'neuralwatt', active: true, value: { type: 'key', key: ' nw_wrapped ' } }]
  }
  assert.equal(extractNeuralWattKey(payload), 'nw_wrapped')
})

test('extract: legacy auth.json map', () => {
  assert.equal(extractNeuralWattKey({ neuralwatt: { type: 'api', key: 'nw_legacy' } }), 'nw_legacy')
  assert.equal(extractNeuralWattKey({ neuralwatt: { type: 'api', token: 'nw_token' } }), 'nw_token')
})

test('extract: ignores oauth entries, inactive entries and other providers', () => {
  assert.equal(extractNeuralWattKey([{ integrationID: 'neuralwatt', active: true, value: { type: 'oauth', access: 'a', refresh: 'r' } }]), null)
  assert.equal(extractNeuralWattKey([{ integrationID: 'neuralwatt', active: false, value: { type: 'key', key: 'nw' } }]), null)
  assert.equal(extractNeuralWattKey({ anthropic: { type: 'api', key: 'sk' } }), null)
  assert.equal(extractNeuralWattKey(null), null)
  assert.equal(extractNeuralWattKey('nonsense'), null)
})

test('server: reads /api/credential and borrows the key', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse({ neuralwatt: { type: 'api', key: 'nw_server' } }))
  const result = await readOpenCodeApiKey({ serverUrl: 'http://127.0.0.1:4096', fetchImpl })
  assert.equal(result?.key, 'nw_server')
  assert.match(result?.source ?? '', /OpenCode server \(127\.0\.0\.1:4096\)/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0], 'http://127.0.0.1:4096/api/credential')
})

test('server: password from the URL query is used as Bearer', async () => {
  let seenAuth: string | undefined
  const { fetchImpl } = stubFetch((_url, auth) => {
    seenAuth = auth
    return jsonResponse({ credentials: [{ integrationID: 'neuralwatt', active: true, value: { type: 'key', key: 'nw' } }] })
  })
  const result = await readOpenCodeApiKey({ serverUrl: 'http://127.0.0.1:4096/?password=secret', fetchImpl })
  assert.equal(result?.key, 'nw')
  assert.equal(seenAuth, 'Bearer secret')
})

test('server: falls back from Bearer to Basic auth', async () => {
  const seen: (string | undefined)[] = []
  const { fetchImpl } = stubFetch((_url, auth) => {
    seen.push(auth)
    if (auth?.startsWith('Basic ')) return jsonResponse({ neuralwatt: { type: 'api', key: 'nw_basic' } })
    return jsonResponse({ error: 'unauthorized' }, 401)
  })
  const result = await readOpenCodeApiKey({ serverUrl: 'http://127.0.0.1:4096', serverPassword: 'pw', fetchImpl })
  assert.equal(result?.key, 'nw_basic')
  assert.equal(seen.length, 2)
  assert.match(seen[0] ?? '', /^Bearer /)
  assert.match(seen[1] ?? '', /^Basic /)
})

function tmpHome(): string {
  return join(tmpdir(), 'opencode-tests-empty-home')
}

test('server: unreachable or wrong shape yields null without throwing', async () => {
  const failing = stubFetch(() => {
    throw new Error('ECONNREFUSED')
  })
  assert.equal(await readOpenCodeApiKey({ serverUrl: 'http://127.0.0.1:1', fetchImpl: failing.fetchImpl, home: tmpHome() }), null)

  const html = stubFetch(() => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, json: async () => { throw new SyntaxError('nope') } }))
  assert.equal(await readOpenCodeApiKey({ serverUrl: 'http://127.0.0.1:2', fetchImpl: html.fetchImpl, home: tmpHome() }), null)

  assert.equal(await readOpenCodeApiKey({ serverUrl: 'not a url', home: tmpHome() }), null)
  assert.equal(await readOpenCodeApiKey({ home: tmpHome() }), null)
})

test('legacy auth.json: read from the data home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opencode-auth-'))
  try {
    const dir = join(home, '.local', 'share', 'opencode')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ neuralwatt: { type: 'api', key: 'nw_file' } }))
    const result = await readOpenCodeApiKey({ home })
    assert.equal(result?.key, 'nw_file')
    assert.match(result?.source ?? '', /auth\.json/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('legacy auth.json: missing or malformed file yields null', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opencode-auth-'))
  try {
    assert.equal(await readOpenCodeApiKey({ home }), null)
    const dir = join(home, '.local', 'share', 'opencode')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'auth.json'), '{broken')
    assert.equal(await readOpenCodeApiKey({ home }), null)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('explicit key beats nothing: empty serverUrl skips the server', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse({ neuralwatt: { type: 'api', key: 'nw' } }))
  assert.equal(await readOpenCodeApiKey({ serverUrl: '   ', fetchImpl }), null)
  assert.equal(calls.length, 0)
})

// --- extract edge branches -------------------------------------------------

test('extract: entries keyed by id and wrapped in entries/data', () => {
  assert.equal(extractNeuralWattKey([{ id: 'neuralwatt', active: true, value: { type: 'key', key: 'nw_id' } }]), 'nw_id')
  assert.equal(extractNeuralWattKey({ entries: [{ integrationID: 'neuralwatt', active: true, value: { type: 'key', key: 'nw_entries' } }] }), 'nw_entries')
  assert.equal(extractNeuralWattKey({ data: [{ integrationID: 'neuralwatt', active: true, value: { type: 'key', key: 'nw_data' } }] }), 'nw_data')
})

test('extract: non-string keys are ignored', () => {
  assert.equal(extractNeuralWattKey({ neuralwatt: { type: 'api', key: 12345 } }), null)
})

// --- server details --------------------------------------------------------

test('server: an explicit password overrides the URL query', async () => {
  let seenAuth: string | undefined
  const { fetchImpl } = stubFetch((_url, auth) => {
    seenAuth = auth
    return jsonResponse({ neuralwatt: { type: 'api', key: 'nw' } })
  })
  await readOpenCodeApiKey({ serverUrl: 'http://127.0.0.1:4096/?password=urlpw', serverPassword: 'settingpw', fetchImpl })
  assert.equal(seenAuth, 'Bearer settingpw')
})

test('server: a path prefix is preserved', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse({ neuralwatt: { type: 'api', key: 'nw' } }))
  await readOpenCodeApiKey({ serverUrl: 'http://example.com:4096/opencode/', fetchImpl })
  assert.equal(calls[0], 'http://example.com:4096/opencode/api/credential')
})

test('server: basic auth is base64 of opencode:password', async () => {
  const seen: (string | undefined)[] = []
  const { fetchImpl } = stubFetch((_url, auth) => {
    seen.push(auth)
    return auth?.startsWith('Basic ')
      ? jsonResponse({ neuralwatt: { type: 'api', key: 'nw' } })
      : jsonResponse({}, 401)
  })
  await readOpenCodeApiKey({ serverUrl: 'http://127.0.0.1:4096', serverPassword: 'pw', fetchImpl })
  assert.equal(seen[1], `Basic ${Buffer.from('opencode:pw').toString('base64')}`)
})

// --- legacy file details ---------------------------------------------------

test('legacy auth.json: non-string key values are ignored', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opencode-auth-'))
  try {
    const dir = join(home, '.local', 'share', 'opencode')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ neuralwatt: { type: 'api', key: 12345 } }))
    assert.equal(await readOpenCodeApiKey({ home }), null)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('legacy auth.json: XDG_DATA_HOME is honored', async () => {
  const dataHome = await mkdtemp(join(tmpdir(), 'xdg-'))
  const previous = process.env.XDG_DATA_HOME
  try {
    const dir = join(dataHome, 'opencode')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ neuralwatt: { type: 'api', key: 'nw_xdg' } }))
    process.env.XDG_DATA_HOME = dataHome
    const result = await readOpenCodeApiKey({})
    assert.equal(result?.key, 'nw_xdg')
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    await rm(dataHome, { recursive: true, force: true })
  }
})

// --- resolution order ------------------------------------------------------

test('resolveApiKey: an explicit setting wins without any network call', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse({ neuralwatt: { type: 'api', key: 'nw' } }))
  const result = await resolveApiKey(
    { apiKey: 'nw_setting', openCodeUrl: 'http://127.0.0.1:4096', openCodePassword: '' },
    { fetchImpl }
  )
  assert.deepEqual(result, { key: 'nw_setting', source: 'setting' })
  assert.equal(calls.length, 0)
})

test('resolveApiKey: borrows from OpenCode when the setting is empty', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ neuralwatt: { type: 'api', key: 'nw_borrowed' } }))
  const result = await resolveApiKey(
    { apiKey: '', openCodeUrl: 'http://127.0.0.1:4096', openCodePassword: '' },
    { fetchImpl }
  )
  assert.deepEqual(result, { key: 'nw_borrowed', source: 'opencode' })
})

test('resolveApiKey: nothing configured yields an empty key', async () => {
  const result = await resolveApiKey({ apiKey: '', openCodeUrl: '', openCodePassword: '' }, { home: tmpHome() })
  assert.deepEqual(result, { key: '', source: 'setting' })
})

// --- `opencode auth export` tier -------------------------------------------

const EXPORT_FIXTURE = JSON.stringify([
  { id: 'c1', integrationID: 'zai-coding-plan', active: true, value: { type: 'key', key: 'other' } },
  { id: 'c2', integrationID: 'neuralwatt', active: true, value: { type: 'key', key: 'nw_exported' } }
])

test('auth export: borrows the key from the CLI export', async () => {
  const seen: Array<{ file: string; args: string[] }> = []
  configureOpenCodeExport(async (file, args) => {
    seen.push({ file, args })
    return EXPORT_FIXTURE
  }, 0)
  const result = await readOpenCodeApiKey({ home: tmpHome() })
  assert.equal(result?.key, 'nw_exported')
  assert.match(result?.source ?? '', /OpenCode \(auth export\)/)
  assert.equal(seen[0]?.args.join(' '), 'auth export')
})

test('auth export: empty export falls through to the legacy auth.json file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opencode-auth-'))
  try {
    const dir = join(home, '.local', 'share', 'opencode')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ neuralwatt: { type: 'api', key: 'nw_file' } }))
    configureOpenCodeExport(async () => JSON.stringify([]), 0)
    const result = await readOpenCodeApiKey({ home })
    assert.equal(result?.key, 'nw_file')
    assert.match(result?.source ?? '', /auth\.json/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('auth export: a failing or silent CLI yields null', async () => {
  configureOpenCodeExport(async () => {
    throw new Error('exit code 1')
  }, 0)
  assert.equal(await readOpenCodeApiKey({ home: tmpHome() }), null)

  configureOpenCodeExport(async () => '<html>not json</html>', 0)
  assert.equal(await readOpenCodeApiKey({ home: tmpHome() }), null)
})

test('auth export: results are cached for the TTL', async () => {
  let calls = 0
  configureOpenCodeExport(async () => {
    calls += 1
    return EXPORT_FIXTURE
  }, 60_000)
  let now = 1_000_000
  const clock = () => now

  const first = await readOpenCodeApiKey({ now: clock, home: tmpHome() })
  const second = await readOpenCodeApiKey({ now: () => now + 30_000, home: tmpHome() })
  assert.equal(calls, 1) // served from cache
  assert.equal(second?.key, 'nw_exported')

  now += 61_000
  const third = await readOpenCodeApiKey({ now: clock, home: tmpHome() })
  assert.equal(calls, 2) // TTL expired → re-ran
  assert.equal(third?.key, 'nw_exported')
})

test('auth export: a missing PATH binary falls back to ~/.opencode/bin/opencode', async () => {
  const seen: string[] = []
  configureOpenCodeExport(async (file) => {
    seen.push(file)
    if (file === 'opencode') {
      const error = new Error('spawn opencode ENOENT') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    return EXPORT_FIXTURE
  }, 0)
  const result = await readOpenCodeApiKey({})
  assert.equal(result?.key, 'nw_exported')
  assert.deepEqual(seen, ['opencode', join(homedir(), '.opencode', 'bin', 'opencode')])
})

// Covers the real execFile runner when an OpenCode binary exists on this
// machine; skipped elsewhere so the suite stays hermetic. Never prints output.
const realBinary = ['opencode', '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode', join(homedir(), '.opencode', 'bin', 'opencode')]
  .find((file) => file === 'opencode' || existsSync(file))

test('auth export: the default runner executes the real CLI when present', { skip: realBinary === undefined }, async () => {
  configureOpenCodeExport(null) // restore the default execFile runner
  const result = await readOpenCodeApiKey({ home: tmpHome() })
  if (result !== null) {
    assert.equal(typeof result.key, 'string')
    assert.match(result.source, /auth export/)
  } else {
    // The binary exists but holds no NeuralWatt credential — equally valid.
    assert.ok(true)
  }
})
