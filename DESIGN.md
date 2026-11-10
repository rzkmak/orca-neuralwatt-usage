# NeuralWatt Usage — Orca Plugin Design

A plugin that shows your NeuralWatt quota and credit balance as an item in **Orca's status bar** (the bar at the bottom of the window), alongside the other usage trackers, and refreshes itself in the background.

- **Research sources:**
  - Orca plugin authoring: https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md
  - Orca manifest reference: https://github.com/stablyai/orca/blob/main/docs/reference/plugin-manifest.md
  - Orca host API reference: https://github.com/stablyai/orca/blob/main/docs/reference/plugin-host-api.md
  - NeuralWatt quota provider (reference implementation): https://github.com/openchamber/openchamber/blob/main/packages/web/server/lib/quota/providers/neuralwatt.js

---

## 1. Why these Orca primitives

| Requirement | Orca primitive chosen | Why |
| --- | --- | --- |
| Shown at the bottom of Orca | `contributes.statusBarItems` (Since 1.4.248) | The status bar is Orca's bottom chrome; up to 8 items per plugin, each with `text`, `icon`, `tone`, `tooltip`, and an optional `command` run on press. Sidebar panels are right-sidebar only, and `sidebarCards` is a reserved (not yet shipped) contribution point, so the status bar is the correct and only placement for this today. |
| Background fetching / polling | `execution: "trusted-worker"` with `main` | Plugin frames (panels) have **no network access** — the frame network is closed. Only the worker (a separate Node process) can call out to `https://api.neuralwatt.com`. The docs explicitly support this pattern: *"A plugin with `main` and status bar items has its worker started when it is enabled and kept running while it stays enabled, so a worker can poll and update its items without an event or a hook."* |
| Updating the status bar live | `statusBar.update` host method (worker-only surface) | `orca.host.call('statusBar.update', { id, text, icon, tone, tooltip })` — fields given replace the current value. The worker re-applies on every poll and on activation (status bar updates last only until Orca restarts, so re-apply on start is required). |
| API key input, replaceable | `contributes.settings` (Since 1.4.246) + `settings:own` | Orca renders declared settings under the plugin in **Settings → Plugins → NeuralWatt Usage**. The user enters the key there and can replace it at any time; the worker re-reads settings every poll cycle, so a replaced key takes effect within one interval. |
| Survive restarts / worker idle | `storage:own` | The last good snapshot is cached in the plugin's private store; on activation the worker paints it into the status bar before the first network round-trip. |

**Execution profile: `trusted-worker`.** It is the lowest profile that gives us a Node worker with network access, and it covers everything else we contribute (status bar item, worker command). Capabilities requested: `settings:own`, `storage:own`. Nothing else — no `workspace:read`, no `agent:read`, no notifications.

---

## 2. NeuralWatt API contract (from the openchamber provider)

### Request

```
GET https://api.neuralwatt.com/v1/quota
Authorization: Bearer <apiKey>
Accept-Encoding: identity
Timeout: 15 s (AbortSignal.timeout(15_000))
```

### Response shape consumed

```jsonc
{
  "subscription": {                       // optional — kWh plan
    "plan": "Pro",                        // plan name → window title
    "kwh_included": 100,
    "kwh_used": 42.5,
    "kwh_reset_date": "<ts>",             // or current_period_end as fallback
    "current_period_end": "<ts>",
    "in_overage": false
  },
  "key": {
    "allowance": {                        // optional — spend cap per period
      "spent_usd": 12.4,
      "limit_usd": 20,
      "period": "daily" | "weekly" | "monthly" | "month" | "yearly" | "year",
      "reset_at": "<ts>",
      "blocked": false
    }
  },
  "balance": {
    "credits_remaining_usd": 18.2        // optional — wallet
  }
}
```

### Normalization rules (ported verbatim in spirit from openchamber)

1. **Subscription window** (`windows[plan ?? "plan_limit"]`)
   - `usedPercent = 100` if `in_overage`, else `kwh_used / kwh_included * 100` clamped to 0–100 (null when `kwh_included` ≤ 0 or fields missing).
   - `resetAt = kwh_reset_date ?? current_period_end`.
   - `windowSeconds = null` — the API exposes no window start, so don't fabricate one.
2. **Allowance window** (`windows[daily|weekly|monthly|billing_cycle]`)
   - The credits wallet is drained by each period's spend before the allowance cap bites, so the **effective ceiling is `min(limit_usd, credits_remaining_usd + spent_usd)`** (falling back to whichever of the two exists).
   - `usedPercent = 100` if `blocked`, else `spent_usd / effectiveLimit * 100` clamped.
   - `windowSeconds` from period: `daily → 86400`, `weekly → 604800`, `monthly|month → 30d`, `yearly|year → 365d` (fixed approximations; the window is for UI labels, not billing). Unknown period → key `billing_cycle`, `windowSeconds = null`.
   - `resetAt = allowance.reset_at`.
3. **Credits fallback** — if there is no allowance but `credits_remaining_usd` exists, add a `credits_balance` window with no percent, `valueLabel: "$18.20"`.
4. **Empty result** (`no windows`) → treated as an error (`No quota data in response`), not an empty success.
5. **Timestamps** — accept epoch seconds, epoch ms, or ISO strings; normalize to ms.
6. **Errors** — `401 → "API key rejected — replace it in Settings"`, other non-OK → `API error: <status>`, `AbortError` → `Request timed out`, `SyntaxError` → `Invalid response from provider`.

---

## 3. File layout

No build step: Orca transpiles worker `.ts` (Since 1.4.246) and panel `.tsx` in place.

```
orca-neuralwatt-usage/
├── orca-plugin.json        # manifest v2
├── README.md
├── DESIGN.md               # this document
├── package.json            # npm test → node --test (only devDependency: @types/node)
├── tsconfig.json           # extends .orca/types/tsconfig.json (from `orca plugin types .`)
├── assets/icon.png         # 256×256 plugin icon (flat, rendered from design/icon.html)
├── images/cover.png        # 1600×1000 plugin-page cover (16:10, ≤1024 KB, from design/cover.html)
├── design/                 # HTML/SVG sources for the icon + cover (re-render with headless Chrome)
└── src/
    ├── protocol.ts         # shared types (all fields required, nulls for unknown — JSON-safe) + storage type guard
    ├── neuralwatt.ts       # pure API client + response normalizer (no Orca imports → unit-testable)
    ├── opencodeauth.ts     # borrows the NeuralWatt key from OpenCode (server API / legacy auth.json) + resolveApiKey
    ├── display.ts          # pure status-bar text / tone / tooltip selection
    ├── schedule.ts         # poll interval, jitter, error backoff (deterministic via injected random)
    ├── settings.ts         # settings normalization, bounds and defaults
    ├── format.ts           # money / "resets in 3d" / "updated 2m ago" helpers
    └── main.ts             # worker: activate(), poll loop, key resolution, status bar, command
└── test/                   # node --test: normalization, display, schedule, settings, OpenCode auth,
    └── *.test.ts           #   formatting, and a worker integration suite (mock Orca host + mock timers)
```

Everything stays far under the limits (2,000 files / 50 MiB per plugin; 1 MiB per transpiled file).

---

## 4. Manifest — `orca-plugin.json`

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json",
  "manifestVersion": 2,
  "execution": "trusted-worker",
  "id": "neuralwatt-usage",
  "name": "NeuralWatt Usage",
  "version": "0.1.0",
  "description": "NeuralWatt quota, spend and credit balance in Orca's status bar.",
  "author": { "name": "<you>" },
  "license": "MIT",
  "engines": { "orca": ">=1.4.248" },   // statusBarItems is Since 1.4.248; TS worker needs >=1.4.246
  "main": "src/main.ts",
  "pluginApi": 1,
  "icon": "assets/icon.png",

  "contributes": {
    "statusBarItems": [
      {
        "id": "neuralwatt",
        "text": "NeuralWatt Balance …",                  // initial paint; worker replaces within a second
        "icon": "zap",
        "tooltip": "NeuralWatt usage",
        "command": "neuralwatt.refresh"  // pressed → worker refreshes now
      }
    ],
    "commands": [
      { "id": "neuralwatt.refresh", "title": "NeuralWatt: Refresh usage now" }
    ],
    "settings": [
      {
        "key": "apiKey",
        "title": "API key",
        "type": "string",
        "maxLength": 256,
        "placeholder": "Paste your NeuralWatt API key",
        "description": "Sent only to https://api.neuralwatt.com as a Bearer token. Replace it here any time; the new key is used on the next refresh."
      },
      {
        "key": "refreshMinutes",
        "title": "Refresh interval (minutes)",
        "type": "integer",
        "default": 5,
        "minimum": 1,
        "maximum": 60
      },
      {
        "key": "display",
        "title": "Status bar display",
        "type": "string",
        "default": "both",
        "enum": ["percent", "credits", "both"],
        "enumLabels": ["Window percent", "Credits balance", "Percent and credits"]
      }
    ]
  },

  "capabilities": [
    { "kind": "settings:own" },
    { "kind": "storage:own" }
  ]
}
```

Notes:

- **No `publisher` field** (deprecated; Orca derives it from the repository owner, so the install key will be `<owner>.neuralwatt-usage`). That requires `engines.orca >= 1.4.246`, which we exceed anyway.
- **API key never rests in plain text.** The Settings fields are **entry-only**: a pasted key (and the OpenCode server password) is moved into Orca's encrypted secret store (`secrets:own` — macOS Keychain) on the next resolve, and the plain field is blanked. A new paste re-migrates; a `?password=` in the server URL is stripped too. Removal is the explicit **NeuralWatt: Forget stored API key** command, which also clears the plain fallback used when the encrypted store is unavailable. See §12 for the full review.
- **OpenCode as a key source.** The worker (full Node, user-account access) can borrow the NeuralWatt credential OpenCode already holds, so the key does not have to be pasted twice. Resolution order each poll: explicit `apiKey` setting → running OpenCode server (`GET /api/credential` on the configured `openCodeUrl`; Bearer then Basic auth, `?password=` in the URL accepted) → **`opencode auth export`** (one-shot CLI printing the stored credentials as JSON; measured ~71 ms on OpenCode 2.2.5, vs 240 ms booting a headless server — so the CLI tier is preferred and the result cached for 60 s; binary looked up on PATH then `~/.opencode/bin/opencode`) → legacy `~/.local/share/opencode/auth.json` (OpenCode 1.x). The tooltip labels the source ("key from OpenCode").
- The plugin asks for **no `notifications:show`** in v0.1; a "you're in overage" desktop notification is an easy later addition.

---

## 5. Shared data model — `src/protocol.ts`

```ts
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type DisplayMode = 'percent' | 'credits' | 'both'

// Every field is always present (null where unknown) so a snapshot survives
// JSON.stringify round-trips through `storage` losslessly and is assignable
// to the host's JsonValue (which has no undefined).
export type UsageWindow = {
  key: string                     // plan name | 'plan_limit' | 'daily' | 'weekly' | 'monthly' | 'billing_cycle' | 'credits_balance'
  title: string                   // plan name or period label
  usedPercent: number | null      // 0–100
  windowSeconds: number | null
  resetAt: number | null          // epoch ms
  valueLabel: string | null       // ready label, e.g. "$18.20" for the credits-only window
  used: number | null             // raw used (kWh or USD)
  limit: number | null            // raw effective limit
  unit: 'kwh' | 'usd' | null
}

export type Snapshot = {
  ok: boolean
  configured: boolean             // an apiKey setting is present
  error: string | null            // human-readable, safe to show (never contains the key)
  fetchedAt: number               // epoch ms of the fetch attempt
  inOverage: boolean
  blocked: boolean                // allowance.blocked
  creditsRemainingUsd: number | null
  planKey: string | null          // key of the subscription window in `windows`
  windows: Record<string, UsageWindow>
  retryAfterMs: number | null     // from a 429 Retry-After
}

export type PluginSettings = { apiKey: string; refreshMinutes: number; display: DisplayMode }
export type StatusBarPaint = { text: string; tone: Tone; tooltip: string }
```

---

## 6. Worker — `src/main.ts`

### Lifecycle

```
Orca enables plugin
  └─ worker starts (kept alive because main + statusBarItems)
      ├─ activate()
      │    ├─ read settings  (settings.get → apiKey, openCodeUrl, refreshMinutes, display)
      │    ├─ resolve key    (setting → OpenCode server /api/credential → `opencode auth export` → legacy auth.json)
      │    ├─ read cached snapshot from storage.get('snapshot')
      │    │    └─ paint status bar from cache immediately (restarts start stale-free)
      │    ├─ kick off poll loop (first fetch right away)
      │    └─ register command + settings.onDidChange listener
      └─ poll loop (while enabled)
           ├─ re-read settings           ← a replaced API key is picked up here
           ├─ if no key → paint "set key" state, sleep, retry
           ├─ fetchQuota()  (neuralwatt.ts, 15 s timeout)
           ├─ on success → normalize → cache in storage → paint
           ├─ on failure → paint error/last-good state → backoff
           └─ sleep  refreshMinutes  ± 10% jitter   (errors: exponential backoff, max 30 min)
```

All host access goes through the documented worker surface:

```ts
import type { OrcaWorkerApi } from 'orca/worker'

export default async function activate(orca: OrcaWorkerApi) {
  const settings = () => orca.host.call('settings.get')            // → Record<string, JSON>
  const paint = (s: StatusBarPaint) =>
    orca.host.call('statusBar.update', { id: 'neuralwatt', ...s }) // worker-only surface
  orca.commands.register('neuralwatt.refresh', () => refreshNow())
  // …poll loop with setTimeout chaining (never setInterval; avoids overlap)
}

export async function deactivate() {} // loop uses an aborted flag; nothing to flush
```

### Behavior details

- **Key resolution:** every poll cycle the key is resolved fresh: the explicit `apiKey` setting wins; if empty, the worker asks a configured OpenCode server (`GET /api/credential`, 3 s timeout, Bearer then Basic) and then OpenCode's legacy `auth.json`. A replaced setting or a newly reachable OpenCode server takes effect immediately (via `settings.onDidChange` / the next tick), and the tooltip says which source is in use.
- **Settings changes (key replacement):** the worker subscribes to `orca.settings.onDidChange`, which hears the person editing settings in Settings live — a replaced API key triggers an immediate refresh with the new key (queued as one trailing refresh if a fetch is already in flight), and display changes repaint from the last good snapshot. Settings are additionally re-read at the top of every tick as a backup.
- **Manual refresh:** the `neuralwatt.refresh` command runs a fetch immediately and resets the backoff schedule. It is debounced (a press while a fetch is in flight is a no-op).
- **Backoff:** after a failure, next attempt = `min(2^n × interval, 30 min)`, reset on success. A `429` with `Retry-After` is honored up to 30 min.
- **Never log the key.** `orca.log` output and error strings must never include `apiKey`; error messages are fixed strings or status codes only.
- **Worker restarts:** Orca may stop an idle worker and start it again later; because we have status bar items + `main`, it is kept running while enabled — and if it ever restarts, `activate()` re-reads everything and re-paints from the storage cache, so no state is lost.

---

## 7. Status bar display spec

The item id is `neuralwatt`; icon `zap`.

### Text selection

| State | Text | Tone | Tooltip |
| --- | --- | --- | --- |
| No API key configured | `NeuralWatt Balance · set key` | `neutral` | "Add your NeuralWatt API key in Settings → Plugins → NeuralWatt Usage." |
| Error, no cached snapshot | `NeuralWatt Balance · offline` | `warning` | The error message + "Retry by clicking." |
| Error, cached snapshot exists | last good text | last good tone | Last good details + `⚠ <error> · updated <rel>` |
| `in_overage` or allowance `blocked` | `NeuralWatt Balance · over` | `danger` | Windows with 100%, reset times |
| Normal | `NeuralWatt Balance 42% · $18.20` | by percent below | Window details (see below) |

Normal-text composition follows the `display` setting:
- `percent` → primary window's `usedPercent` rounded (`42%`)
- `credits` → `$<credits_remaining_usd>` (2 decimals, trailing `.00` trimmed)
- `both` → `42% · $18.20` (parts omitted when null; `NeuralWatt Balance` alone if nothing available)

**Primary window** = the allowance window (`daily`/`weekly`/`monthly`/`billing_cycle`) when present, else the subscription plan window — matching how openchamber orders importance (spend cap bites before the kWh plan does).

### Tone thresholds (primary window percent)

| Percent | Tone |
| --- | --- |
| < 75 | `neutral` |
| 75 – 89 | `warning` |
| ≥ 90 | `danger` |
| overage / blocked | `danger` regardless |

### Tooltip (multi-line plain string)

```
NeuralWatt
Pro: 42% of 100 kWh · resets in 3d
Monthly: $12.40 of $20.00 · resets in 11h
Credits: $18.20
Updated 2m ago
```

(only the lines that exist; an error line is appended when the last fetch failed; "resets in" derived from `resetAt` / `windowSeconds`).

### Press behavior

Clicking the item runs the `neuralwatt.refresh` worker command (immediate refresh + backoff reset). Deliberate choice: `shell.openExternal` is **panel/editor-only** (worker can't open a browser tab), so "open NeuralWatt dashboard on click" is only possible via the phase-2 panel, where a clicked Link can open it.

---

## 8. Phase 2 (optional) — detail panel

A `components` panel (`contributes.panels`, allowed because `trusted-worker` ≥ `sandboxed-ui`):

- `entry: "src/panel.tsx"`, `ui: "components"`, `icon: "gauge"`, title "NeuralWatt".
- Renders one progress row per usage window (percent, title, reset time), the credits balance, last-updated time, an error banner, a **Refresh** button, and a Link to the NeuralWatt dashboard (`shell.openExternal`, needs the click — fine in a panel).
- Worker side: `orca.panels.handle('snapshot.get', …)` and `orca.panels.handle('refresh', …)`; pushes `orca.panels.post('snapshot.changed', snapshot)` after every paint so open panels stay live.
- Contract declared once in `src/protocol.ts` via `declare module 'orca' { interface PluginRequests { … } }`.
- The panel can also read the same settings (e.g. to show a "key not set" call-to-action).

This is deliberately out of v0.1 scope; the status bar alone fulfills the requirement.

---

## 9. Testing & development loop

```bash
# scaffold check + typings
orca plugin create . --template worker-panel   # reference only; we hand-write the manifest
orca plugin types .

# validate manifest strictly
orca plugin validate .

# load as a development plugin, watch logs, run checks, auto-shot the panel
orca plugin dev watch . --check

# capture exactly what Orca draws at the bottom of the window
orca plugin shot . --status-bar --theme dark
orca plugin shot . --status-bar --theme light
```

- **Unit tests (no Orca needed):** `src/neuralwatt.ts` is pure — feed it recorded JSON fixtures (subscription only; allowance only; credits only; all three; `in_overage`; `blocked`; 401; malformed) with `node:test` and assert the normalized `Snapshot`.
- **Manual:** `Settings → Plugins → Development folders → add this repo`, enable, then replace the API key mid-run and confirm the next tick (or a status-bar click) uses it.
- Approval flow: first load prints what the plugin would be granted (`trusted-worker`, `settings:own`, `storage:own`, 1 status bar item, 1 command) and asks to approve.

## 10. Publishing checklist (later)

1. `orca plugin validate .` green, committed, pushed to the GitHub repo whose owner becomes the publisher.
2. Tag: `git tag -a v0.1.0 -m v0.1.0 && git push origin v0.1.0`.
3. `orca plugin release-entry .` → paste the printed entry into a catalog's `orca-catalog.json` (or just install via `orca plugin install <owner>/orca-neuralwatt-usage` without a catalog).

## 11. Decisions & open questions

| Decision | Rationale |
| --- | --- |
| `trusted-worker` over `sandboxed-ui` + panel | Frames have no network; polling + `statusBar.update` require the worker. It also keeps the worker alive while enabled — exactly the tracker pattern. |
| API key in `settings` (not `secrets`) | Matches "input in provider, can be replaced": Orca renders a replaceable form field under the plugin in Settings. Alternative (panel + `secrets.set`) documented in §4. |
| Click = refresh, not "open dashboard" | `shell.openExternal` is panel-only; a worker command can't open a browser. Revisit when the panel ships. |
| Re-read settings each tick + `settings.onDidChange` | The change listener makes key replacement instant; the per-tick re-read is a zero-cost backup. No extra capabilities. |
| Borrow the key from OpenCode when the setting is empty | Verified live on OpenCode 2.2.5: `opencode auth export` prints the stored credentials in ~71 ms (one-shot CLI, no orphan risk) and headless `opencode serve` boots in ~240 ms with Basic-auth `/api/credential`. The CLI tier wins; the result is cached 60 s so poll cycles never re-spawn it constantly. |
| 30-day/365-day fixed window lengths | Same approximation openchamber makes; windows label the UI, not billing. |
| Open: kWh window `windowSeconds: null` | The API exposes no window start; we don't fabricate one (openchamber's choice too). |

---

## 12. Security review (2026-11-10)

Assets: the NeuralWatt API key, the OpenCode server password, the OpenCode credential store, and the cached usage snapshot.

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | API key was stored **in plain text** by Orca settings (`plugins-data/<key>/settings.json`) | High (at-rest) | **Fixed** — settings fields are entry-only; values migrate into the encrypted secret store (`secrets:own` → macOS Keychain) and the plain field is blanked. A replaced paste re-migrates. |
| 2 | OpenCode server password, same plaintext store (and sometimes embedded as `?password=` in the URL) | Medium | **Fixed** — same migration; the URL query is stripped after the move. |
| 3 | No way to remove a stored key (secret outlives the blanked field) | Medium | **Fixed** — `neuralwatt.forgetKeys` command deletes Keychain entries *and* the plain-settings fallback. |
| 4 | Encrypted store unavailable (some Linux setups) → migration would lose the key | Low | **Accepted** — falls back to plain settings with a log line, so the plugin keeps working; removal still clears it. |
| 5 | Plain text persists between typing in Settings and the next worker resolve | Low | **Accepted** — bounded by one poll interval (or an immediate settings-change event); no way to intercept Orca's own write earlier. |
| 6 | `opencode auth export` stdout contains **all** of the user's credentials | Context | **Mitigated** — captured, parsed, only the NeuralWatt key retained; never logged; execFile with fixed args (no shell, nothing in argv). Inherent to OpenCode's design: any process running as the user can read the same store. |
| 7 | Cached snapshot in `storage.json` | Info | **No key material** (verified: snapshot only); contains usage numbers only. Directory is `700`, files `600`. |
| 8 | Logs | Info | **No secrets** — error strings are fixed messages or status codes; keys never logged or shown in tooltips. |
| 9 | Transport | Info | API key travels only over TLS to `api.neuralwatt.com`; OpenCode reads are localhost; spawned-server path (not used) would set its own random password. |
| 10 | OpenCode-side storage (`opencode.db`, mode 600) and its local credential API | Context | Owned by OpenCode, not this plugin; the plugin only reads what OpenCode already exposes to local clients. |

Trust boundary note: the worker runs with full user-account access by design (`trusted-worker`); every secret it handles is already readable by any process running as the same user. The review's goal was to ensure the plugin adds no *new* plaintext at rest — it no longer does.
