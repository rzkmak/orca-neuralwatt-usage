import type { OrcaWorkerApi } from 'orca/worker'
import { fetchQuota } from './neuralwatt.ts'
import { resolveApiKey } from './opencodeauth.ts'
import { initialPaint, paintFor, unconfiguredPaint } from './display.ts'
import { backoffMs, intervalMs, nextDelayMs } from './schedule.ts'
import { normalizeRawSettings } from './settings.ts'
import { isSnapshot } from './protocol.ts'
import type { KeySource, PluginSettings, Snapshot, StatusBarPaint } from './protocol.ts'

const STATUS_BAR_ID = 'neuralwatt'
const SNAPSHOT_KEY = 'snapshot'
const SECRET_API_KEY = 'apiKey'
const SECRET_OPENCODE_PASSWORD = 'openCodePassword'
const FETCH_TIMEOUT_MS = 15_000
const OPENCODE_TIMEOUT_MS = 3_000
const DEFAULT_SETTINGS: PluginSettings = {
  apiKey: '',
  refreshMinutes: 5,
  display: 'both',
  openCodeUrl: '',
  openCodePassword: ''
}

let disposed = false
let inFlight = false
let pendingRefresh = false
let consecutiveFailures = 0
let selfWriteDepth = 0
let settings: PluginSettings = DEFAULT_SETTINGS
let resolvedKey: { key: string; source: KeySource } = { key: '', source: 'setting' }
let lastGood: Snapshot | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const disposables: Array<{ dispose(): void }> = []

/**
 * Orca starts this worker when the plugin is enabled and keeps it running
 * while it stays enabled (main + status bar items), so a plain poll loop
 * needs no events or hooks.
 */
export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  disposed = false
  inFlight = false
  pendingRefresh = false
  consecutiveFailures = 0
  settings = await readSettings(orca)
  resolvedKey = await resolveKey(orca)
  lastGood = await readCachedSnapshot(orca)

  disposables.push(
    orca.commands.register('neuralwatt.refresh', () => {
      void refresh(orca, true)
    }),
    orca.commands.register('neuralwatt.forgetKeys', () => {
      void forgetKeys(orca)
    }),
    // The person replacing the API key (or tuning interval/display) in Settings
    // takes effect immediately; the poll loop's own settings re-read is the backup.
    orca.settings.onDidChange(({ key }) => {
      // Writes the worker made itself (blanking a migrated field) are echoes, not edits.
      if (selfWriteDepth > 0) return
      if (key === 'apiKey' || key === 'openCodeUrl' || key === 'openCodePassword' || key === 'refreshMinutes' || key === 'display') {
        void applySettingsChange(orca)
      }
    })
  )

  // Paint the cached snapshot before the first network round-trip so the bar
  // is never blank after an Orca restart (status bar updates reset on restart).
  await paint(orca, lastGood !== null ? paintFor(paintSettings(), lastGood, lastGood, resolvedKey.source) : initialPaint(resolvedKey.key !== ''))
  schedule(orca, 0)
}

export async function deactivate(): Promise<void> {
  disposed = true
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  for (const disposable of disposables) disposable.dispose()
  disposables.length = 0
}

function schedule(orca: OrcaWorkerApi, delayMs: number): void {
  if (disposed) return
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void refresh(orca, false)
  }, Math.max(0, delayMs))
}

/** One fetch + repaint cycle. Debounced: a manual call while a fetch is in flight queues one trailing refresh. */
async function refresh(orca: OrcaWorkerApi, manual: boolean): Promise<void> {
  if (disposed) return
  if (inFlight) {
    if (manual) pendingRefresh = true
    return
  }
  inFlight = true
  try {
    settings = await readSettings(orca)
    resolvedKey = await resolveKey(orca)
    if (manual) consecutiveFailures = 0

    if (resolvedKey.key === '') {
      await paint(orca, unconfiguredPaint())
      schedule(orca, intervalMs(settings))
      return
    }

    const snapshot = await fetchQuota(resolvedKey.key, { timeoutMs: FETCH_TIMEOUT_MS })
    if (snapshot.ok) {
      consecutiveFailures = 0
      lastGood = snapshot
      await orca.storage.set(SNAPSHOT_KEY, snapshot)
    } else {
      consecutiveFailures += 1
    }
    await paint(orca, paintFor(paintSettings(), snapshot, lastGood, resolvedKey.source))
    schedule(orca, nextDelayMs(settings, snapshot, consecutiveFailures))
  } catch (error) {
    orca.log(`neuralwatt-usage: refresh failed: ${errorMessage(error)}`)
    consecutiveFailures += 1
    schedule(orca, backoffMs(settings, consecutiveFailures))
  } finally {
    inFlight = false
    if (pendingRefresh && !disposed) {
      pendingRefresh = false
      schedule(orca, 0)
    }
  }
}

async function readSecret(orca: OrcaWorkerApi, name: string): Promise<string> {
  try {
    const value = await orca.secrets.get(name)
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/** Best effort: true once the value lives in the encrypted secret store (macOS Keychain). */
async function storeSecret(orca: OrcaWorkerApi, name: string, value: string): Promise<boolean> {
  try {
    await orca.secrets.set(name, value)
    return true
  } catch (error) {
    orca.log(`neuralwatt-usage: could not store "${name}" encrypted; keeping it in plain settings (${errorMessage(error)})`)
    return false
  }
}

/** A settings write the worker performs itself; its change event is an echo, not a person's edit. */
async function writeSettingQuietly(orca: OrcaWorkerApi, key: string, value: string): Promise<void> {
  selfWriteDepth += 1
  try {
    await orca.settings.set(key, value)
  } finally {
    selfWriteDepth -= 1
  }
}

/**
 * Where the API key comes from, evaluated every cycle. The encrypted secret
 * store wins; a key pasted into Settings is moved there (out of the plain
 * settings file) and the field blanked; otherwise the key OpenCode already
 * holds is borrowed (running server, then `auth export`, then legacy
 * auth.json). The key is never logged.
 */
async function resolveKey(orca: OrcaWorkerApi): Promise<{ key: string; source: KeySource }> {
  // A fresh paste in Settings (new or changed) overrides the stored secret:
  // the field is entry-only, so any non-empty value that differs is a new key.
  const storedKey = await readSecret(orca, SECRET_API_KEY)
  if (settings.apiKey !== '' && settings.apiKey !== storedKey) {
    if (await storeSecret(orca, SECRET_API_KEY, settings.apiKey)) {
      await writeSettingQuietly(orca, 'apiKey', '')
    }
    return { key: settings.apiKey, source: 'setting' }
  }
  if (storedKey !== '') return { key: storedKey, source: 'setting' }

  // Nothing pasted: borrow the key OpenCode already holds.
  await migrateOpenCodePassword(orca)
  const serverPassword = await readSecret(orca, SECRET_OPENCODE_PASSWORD)
  return await resolveApiKey(
    { apiKey: '', openCodeUrl: settings.openCodeUrl, openCodePassword: serverPassword },
    { timeoutMs: OPENCODE_TIMEOUT_MS }
  )
}

/** The OpenCode server password never belongs in the plain settings file: the
 *  setting — or a `?password=` embedded in the URL — is moved into the
 *  encrypted store once, and the plain copy removed. */
async function migrateOpenCodePassword(orca: OrcaWorkerApi): Promise<void> {
  if ((await readSecret(orca, SECRET_OPENCODE_PASSWORD)) !== '') return
  if (settings.openCodePassword !== '') {
    if (await storeSecret(orca, SECRET_OPENCODE_PASSWORD, settings.openCodePassword)) {
      await writeSettingQuietly(orca, 'openCodePassword', '')
    }
    return
  }
  if (!settings.openCodeUrl.includes('password=')) return
  try {
    const url = new URL(settings.openCodeUrl)
    const password = url.searchParams.get('password')
    if (password === null || password === '') return
    if (await storeSecret(orca, SECRET_OPENCODE_PASSWORD, password)) {
      url.searchParams.delete('password')
      await writeSettingQuietly(orca, 'openCodeUrl', url.toString())
    }
  } catch {
    // not a parseable URL — leave it alone
  }
}

/** Removes every credential the plugin stores — the encrypted secret store and
 *  any plain settings fallback — then re-resolves (the OpenCode tiers may
 *  still supply a working key). */
async function forgetKeys(orca: OrcaWorkerApi): Promise<void> {
  try {
    await orca.secrets.delete(SECRET_API_KEY)
    await orca.secrets.delete(SECRET_OPENCODE_PASSWORD)
  } catch (error) {
    orca.log(`neuralwatt-usage: could not clear stored credentials: ${errorMessage(error)}`)
  }
  settings = await readSettings(orca)
  if (settings.apiKey !== '') await writeSettingQuietly(orca, 'apiKey', '')
  if (settings.openCodePassword !== '') await writeSettingQuietly(orca, 'openCodePassword', '')
  settings = await readSettings(orca)
  resolvedKey = await resolveKey(orca)
  if (resolvedKey.key === '') {
    await paint(orca, unconfiguredPaint())
    return
  }
  await refresh(orca, true)
}

/** Settings as seen by the display: the resolved key decides "configured" vs "set key". */
function paintSettings(): PluginSettings {
  return { ...settings, apiKey: resolvedKey.key }
}

/** A watched setting changed in Settings: repaint, and re-fetch at once when the key source changed. */
async function applySettingsChange(orca: OrcaWorkerApi): Promise<void> {
  if (disposed) return
  const previous = resolvedKey
  settings = await readSettings(orca)
  resolvedKey = await resolveKey(orca)
  if (resolvedKey.key !== previous.key) {
    if (resolvedKey.key === '') {
      await paint(orca, unconfiguredPaint())
      return
    }
    await refresh(orca, true)
    return
  }
  // Display (or interval) changed: repaint from the last good snapshot now;
  // the next tick already picks up a changed interval.
  if (lastGood !== null) await paint(orca, paintFor(paintSettings(), lastGood, lastGood, resolvedKey.source))
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

async function readSettings(orca: OrcaWorkerApi): Promise<PluginSettings> {
  try {
    return normalizeRawSettings(await orca.settings.get())
  } catch (error) {
    orca.log(`neuralwatt-usage: could not read settings: ${errorMessage(error)}`)
    return DEFAULT_SETTINGS
  }
}

async function readCachedSnapshot(orca: OrcaWorkerApi): Promise<Snapshot | null> {
  try {
    const value = await orca.storage.get(SNAPSHOT_KEY)
    return isSnapshot(value) ? value : null
  } catch {
    return null
  }
}

async function paint(orca: OrcaWorkerApi, next: StatusBarPaint): Promise<void> {
  try {
    await orca.host.call('statusBar.update', {
      id: STATUS_BAR_ID,
      text: next.text,
      tone: next.tone,
      tooltip: next.tooltip
    })
  } catch (error) {
    orca.log(`neuralwatt-usage: status bar update failed: ${errorMessage(error)}`)
  }
}
