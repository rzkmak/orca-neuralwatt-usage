# NeuralWatt Usage for Orca

An [Orca plugin](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md) that shows your NeuralWatt quota, spend and credit balance as an item in **Orca's status bar** (bottom of the window) and refreshes itself in the background. Design details in [DESIGN.md](./DESIGN.md).

```
⚡ NeuralWatt Balance 62% · $18.20   ← green until 75%, amber to 90%, red above or in overage
```

## Install (development)

```bash
orca plugin dev watch .        # from this folder; approves on first load
# or, without a terminal:
# Settings → Plugins → Turn on plugins → Development folders… → add this folder
```

> Note: if the plugin is already loaded and you pull changes that add capabilities (this repo recently added `secrets:own`), the reload asks for approval again — `orca plugin dev reload . --approve <fingerprint>`.

## Configure

1. **Settings → Plugins → NeuralWatt Usage → API key** — paste your NeuralWatt API key. The field is **entry-only**: on the next refresh the key is moved into the encrypted secret store (macOS Keychain) and the field is cleared. Paste a new value any time to rotate; the old one is overwritten.
2. **No key at hand? Borrow it from OpenCode** — automatic, tried when no key is stored:
   - **`opencode auth export`** (default): a one-shot CLI call (~70 ms, cached for a minute) that prints the credentials OpenCode stores — the plugin keeps only the NeuralWatt key. Works with zero configuration as long as you've connected NeuralWatt in OpenCode.
   - **OpenCode server URL**: a running server (e.g. `http://127.0.0.1:4096`, optionally with `?password=…` — the password is moved into encrypted storage and stripped from the URL) whose `GET /api/credential` is queried instead.
3. Optional: refresh interval (1–60 min, default 5) and what the bar shows (percent, credits, or both).

**Key precedence:** explicit API key (Keychain) → OpenCode server URL → `opencode auth export` → legacy `~/.local/share/opencode/auth.json`. The tooltip shows which source is in use ("key from OpenCode").

The key is sent only to `https://api.neuralwatt.com/v1/quota` as a Bearer token and never appears in logs, errors, or tooltips.

## Where is the key stored?

| Source | Location |
| --- | --- |
| Pasted API key | **macOS Keychain** via Orca's encrypted secret store (`secrets:own`). The Settings field is entry-only: the value is moved there and the field is cleared automatically |
| OpenCode server password | macOS Keychain (same migration; a `?password=` embedded in the server URL is stripped too) |
| OpenCode server | held by OpenCode in its own database; read over `GET /api/credential` or the one-shot `opencode auth export` CLI; kept in memory only |
| Legacy auth.json | `~/.local/share/opencode/auth.json` (OpenCode 1.x), owned by OpenCode |
| Runtime | the worker holds the resolved key in memory only; the cached usage snapshot (no key inside) sits in `plugins-data/local.neuralwatt-usage/storage.json` |

**Removal:** run **NeuralWatt: Forget stored API key** (command palette) — clears the Keychain entries and any plain fallback. If the encrypted store is unavailable (some Linux setups), the key deliberately stays in plain settings so the plugin keeps working; the log says so. Full review in DESIGN.md §12.

## Status bar states

| State | Text | Colour |
| --- | --- | --- |
| No API key | `NeuralWatt Balance · set key` | neutral |
| Fetching (no cache yet) | `NeuralWatt Balance …` | neutral |
| Normal | `NeuralWatt Balance 62% · $18.20` | neutral / warning (≥75%) / danger (≥90%) |
| In overage or spend-blocked | `NeuralWatt Balance · over` | danger |
| Request failed, no cache | `NeuralWatt Balance · offline` | warning |
| Request failed, cache exists | last good text | unchanged (error noted in tooltip) |

Hover for per-window details (kWh plan, spend window, credits, reset times). **Click** the item to refresh immediately.

## Commands

| Command | What it does |
| --- | --- |
| **NeuralWatt: Refresh usage now** | Immediate refresh (also bound to clicking the status bar item) |
| **NeuralWatt: Forget stored API key** | Removes the stored credentials — the Keychain entries and any plain fallback — then re-resolves (the OpenCode tiers may still supply a working key) |

## Security

The Settings fields are **entry-only**: anything you paste is moved into Orca's encrypted secret store (macOS Keychain via `secrets:own`) and the plain field is cleared — the key never rests in the plain settings file. OpenCode-borrowed keys are held in memory only. Removal is the forget command. Full review with findings and residual risks in [DESIGN.md §12](./DESIGN.md).

## Development

```bash
npm test                              # 124 tests (unit + worker integration with a mock Orca host)
node --test --experimental-test-coverage test/*.test.ts   # 100% line coverage, ~97% branch
orca plugin validate .                # strict manifest checks
orca plugin types .                   # writes Orca typings + tsconfig into .orca/types
orca plugin dev watch . --check       # load into Orca, hot-reload, log panels/worker
orca plugin shot . --status-bar       # capture the status bar exactly as Orca draws it
```

## Files

| File | Purpose |
| --- | --- |
| `orca-plugin.json` | Manifest: status bar item, 2 commands (refresh / forget key), 5 settings, capabilities (`settings:own`, `storage:own`, `secrets:own`) |
| `src/main.ts` | Worker entry: poll loop, key resolution + Keychain migration, status bar paint, commands, settings listener |
| `src/neuralwatt.ts` | Pure API client + response normalizer (no Orca imports) |
| `src/opencodeauth.ts` | Key borrowing: OpenCode server (`/api/credential`), `opencode auth export` CLI tier, legacy `auth.json`; `resolveApiKey` |
| `src/display.ts` | Pure status-bar text/tone/tooltip selection |
| `src/schedule.ts` | Poll interval, jitter, error backoff math |
| `src/settings.ts` | Settings normalization, bounds and defaults |
| `src/format.ts` | Money, percent, relative-time helpers |
| `src/protocol.ts` | Shared types + the storage snapshot type guard |
| `test/` | `node --test` suites: normalization, display, schedule, settings, OpenCode auth (incl. the export tier), formatting, and a worker integration suite (mock Orca host + mock timers) |

## License

[MIT](./LICENSE) — matches the `license` declared in `orca-plugin.json` and satisfies the Orca plugin listing policy.
