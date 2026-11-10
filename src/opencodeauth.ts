import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FetchLike } from './neuralwatt.ts'

export type OpenCodeKey = { key: string; source: string }

export type OpenCodeDeps = {
  /** Base URL of a running OpenCode server, e.g. "http://127.0.0.1:4096". A `?password=` query parameter is also accepted. */
  serverUrl?: string
  /** Server password (`OPENCODE_SERVER_PASSWORD`); overrides one embedded in the URL. */
  serverPassword?: string
  fetchImpl?: FetchLike
  /** Overrides the home directory (tests). */
  home?: string
  timeoutMs?: number
  /** Injectable clock for the export cache (tests). */
  now?: () => number
}

export type ExportRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>

const REQUEST_TIMEOUT_MS = 3_000
const EXPORT_TIMEOUT_MS = 10_000
const EXPORT_CACHE_TTL_MS = 60_000
const PROVIDER_ID = 'neuralwatt'

// --- `opencode auth export` (one-shot CLI, the automatic credential source) ---

let exportRunner: ExportRunner | null = null
let exportCacheTtlMs = EXPORT_CACHE_TTL_MS
let exportCache: { at: number; result: OpenCodeKey | null } | null = null

/**
 * Overrides how `opencode auth export` runs. A runner makes the export tier
 * deterministic in tests; null restores the default (execFile). Resets the
 * export cache, so call this between test scenarios.
 */
export function configureOpenCodeExport(runner: ExportRunner | null, ttlMs: number = EXPORT_CACHE_TTL_MS): void {
  exportRunner = runner
  exportCacheTtlMs = ttlMs
  exportCache = null
}

const defaultExportRunner: ExportRunner = (file, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })

/** `opencode` on PATH first, then the well-known install location. */
function exportCandidates(home?: string): string[] {
  return ['opencode', join(home ?? homedir(), '.opencode', 'bin', 'opencode')]
}

function isMissingBinary(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/**
 * Runs `opencode auth export` (which prints every stored credential, secrets
 * included, as JSON) and keeps only the NeuralWatt key. The result — including
 * a negative one — is cached for the TTL so poll cycles never re-spawn the CLI
 * more often than that. The stdout is never logged.
 */
async function readExportedApiKey(now: number, home?: string): Promise<OpenCodeKey | null> {
  if (exportCache !== null && now - exportCache.at < exportCacheTtlMs) return exportCache.result
  const runner = exportRunner ?? defaultExportRunner
  let result: OpenCodeKey | null = null
  for (const file of exportCandidates(home)) {
    try {
      const stdout = await runner(file, ['auth', 'export'], EXPORT_TIMEOUT_MS)
      const key = extractNeuralWattKey(JSON.parse(stdout))
      result = key !== null ? { key, source: 'OpenCode (auth export)' } : null
      break
    } catch (error) {
      if (!isMissingBinary(error)) break // binary ran and failed — don't chase other candidates
      // ENOENT → try the next well-known location
    }
  }
  exportCache = { at: now, result }
  return result
}

/**
 * Finds a NeuralWatt API key that OpenCode already holds, so the person does
 * not have to paste it into Orca. Three sources, in order:
 *
 *  1. a running OpenCode server: `GET /api/credential` — the same credential
 *     read OpenCode's own quota consumers use. OpenCode 2.x keeps credentials
 *     in its database and hands them out here, keyed by integration id.
 *  2. `opencode auth export`: a one-shot CLI that prints the stored
 *     credentials as JSON (measured ~71 ms on OpenCode 2.2.5). Cached for a
 *     minute so poll cycles do not re-spawn it constantly.
 *  3. OpenCode's legacy `~/.local/share/opencode/auth.json` (OpenCode 1.x).
 *
 * Never throws; null means "no key found". The key itself is never logged and
 * only ever returned to the caller.
 */
export async function readOpenCodeApiKey(deps: OpenCodeDeps = {}): Promise<OpenCodeKey | null> {
  if (deps.serverUrl !== undefined && deps.serverUrl.trim() !== '') {
    const fromServer = await readFromServer(deps.serverUrl.trim(), deps)
    if (fromServer !== null) return fromServer
  }
  const exported = await readExportedApiKey((deps.now ?? Date.now)(), deps.home)
  if (exported !== null) return exported
  return readFromLegacyAuthFile(deps.home)
}

function endpoint(serverUrl: string, serverPassword?: string): { url: string; host: string; password: string } {
  let parsed: URL
  try {
    parsed = new URL(serverUrl)
  } catch {
    return { url: '', host: '', password: '' }
  }
  const password = serverPassword?.trim() || parsed.searchParams.get('password')?.trim() || ''
  const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  return { url: `${base}/api/credential`, host: parsed.host, password }
}

async function readFromServer(serverUrl: string, deps: OpenCodeDeps): Promise<OpenCodeKey | null> {
  const fetchImpl = (deps.fetchImpl ?? fetch) as FetchLike
  const target = endpoint(serverUrl, deps.serverPassword)
  if (target.url === '') return null

  for (const headers of authHeaderCandidates(target.password)) {
    const timeoutSignal = AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS)
    try {
      const response = await fetchImpl(target.url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: timeoutSignal })
      if (!response.ok) continue
      const payload: unknown = await response.json()
      const key = extractNeuralWattKey(payload)
      if (key !== null) return { key, source: `OpenCode server (${target.host})` }
    } catch {
      // Unreachable, unauthorized, or not JSON — try the next auth style.
    }
  }
  return null
}

/**
 * OpenCode servers are protected with a password (`OPENCODE_SERVER_PASSWORD`);
 * the auth header style moved between versions, so both are tried.
 */
function authHeaderCandidates(password: string): Array<Record<string, string>> {
  if (password === '') return [{}]
  const basic = Buffer.from(`opencode:${password}`).toString('base64')
  return [{ Authorization: `Bearer ${password}` }, { Authorization: `Basic ${basic}` }]
}

async function readFromLegacyAuthFile(home?: string): Promise<OpenCodeKey | null> {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(home ?? homedir(), '.local', 'share')
  let raw: string
  try {
    raw = await readFile(join(dataHome, 'opencode', 'auth.json'), 'utf8')
  } catch {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return null
  }
  const key = extractNeuralWattKey(payload)
  return key !== null ? { key, source: 'OpenCode (auth.json)' } : null
}

/**
 * Pulls the NeuralWatt key out of a credential listing. Handles both shapes
 * seen in the wild: OpenCode 2.x credential entries
 * (`[{ integrationID, active, value: { type: 'key', key } }]`, with or without
 * a `{ credentials: [...] }` wrapper) and the legacy auth.json map
 * (`{ neuralwatt: { type: 'api', key } }`).
 */
export function extractNeuralWattKey(payload: unknown): string | null {
  for (const entry of credentialEntries(payload)) {
    const id = typeof entry.integrationID === 'string' ? entry.integrationID : typeof entry.id === 'string' ? entry.id : ''
    if (id !== PROVIDER_ID) continue
    if (entry.active === false) continue
    const key = keyFromEntry(entry)
    if (key !== null) return key
  }
  return null
}

function credentialEntries(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter(isPlainObject)
  const obj = asPlainObject(payload)
  if (obj === null) return []
  for (const field of ['credentials', 'entries', 'data']) {
    const list = obj[field]
    if (Array.isArray(list)) return list.filter(isPlainObject)
  }
  return Object.entries(obj)
    .filter(([, value]) => isPlainObject(value))
    .map(([id, value]) => ({ integrationID: id, ...(value as Record<string, unknown>) }))
}

function keyFromEntry(entry: Record<string, unknown>): string | null {
  const value = isPlainObject(entry.value) ? entry.value : entry
  for (const candidate of [value.key, value.token, entry.key, entry.token]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return null
}

export type ResolvedApiKey = { key: string; source: 'setting' | 'opencode' }

/**
 * The worker's key resolution order: an explicit Orca setting wins; otherwise
 * borrow the key OpenCode already holds (running server, then legacy auth.json).
 * Empty key means nothing is configured.
 */
export async function resolveApiKey(
  settings: { apiKey: string; openCodeUrl: string; openCodePassword: string },
  deps: OpenCodeDeps = {}
): Promise<ResolvedApiKey> {
  if (settings.apiKey !== '') return { key: settings.apiKey, source: 'setting' }
  const borrowed = await readOpenCodeApiKey({
    serverUrl: settings.openCodeUrl,
    serverPassword: settings.openCodePassword,
    ...deps
  })
  return borrowed !== null ? { key: borrowed.key, source: 'opencode' } : { key: '', source: 'setting' }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null
}
