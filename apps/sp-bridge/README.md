# sp-bridge

**SP Bridge** — a small headless Windows agent that serves **Super Productivity's
local REST API** and syncs to a **SuperSync server**, with data that is
interchangeable with the real Super Productivity clients.

> **Status: syncs.** The bridge boots, replays its operation log, serves the
> local REST API, writes every mutation to disk as a Super Productivity–compatible
> operation, and exchanges operations with a SuperSync server (E2EE, LWW
> conflicts included). The `/focus` timer is the remaining work, listed in
> [Roadmap](#roadmap).

## The approach

The obvious way to build this is to reimplement the task domain. That is the
wrong way, and expensive: Super Productivity's operations are not a neutral
data format, they are **NgRx action-type strings** (`'[Task Shared] addTask'`)
carrying app-specific payload shapes, applied on the receiving client by the
app's own reducers. A parallel implementation would drift, and drift here is
silent and cross-device.

So the agent does not reimplement the domain. It **reuses it**:

### Dependencies

The agent's own `package.json` declares **build and packaging tooling only**
(esbuild, electron, electron-builder, typescript, prettier). It deliberately does
**not** declare Angular, NgRx, rxjs, zod and friends, even though it imports them
transitively through the app sources it reuses.

Those come from the repository's own `npm ci`. The agent is part of this repo
and type-checks part of it, so their resolution path is the repo's — and
hand-copying a subset of the app's manifest into the agent both drifts and risks
putting two Angular copies on one type path. The last entry in
[Traps](#traps-hit-while-building-this) is what that cost.

```bash
npm ci --ignore-scripts          # repo root: the app dependencies
cd apps/sp-bridge && npm ci  # the agent's build tooling
```

| Concern                | Reused from Super Productivity                                       |
| ---------------------- | -------------------------------------------------------------------- |
| Operation wire format  | `src/app/op-log/core/operation.types.ts`, `@sp/shared-schema`        |
| Action vocabulary      | `src/app/op-log/core/action-types.enum.ts` (immutable strings)       |
| Sync `meta` on actions | the real action creators (`TaskSharedActions.addTask` etc.)          |
| State transitions      | the real feature reducers (`taskReducer`, `projectReducer`, …)       |
| Cross-entity semantics | the real meta-reducers, in the app's authoritative order             |
| Op → action replay     | `src/app/op-log/apply/operation-converter.util.ts`                   |
| Vector clocks          | `src/app/core/util/vector-clock.ts` + `@sp/sync-core`                |
| SuperSync transport    | `@sp/sync-providers` (`SuperSyncProvider`)                           |
| Encryption             | `@sp/sync-core`                                                      |
| Meta-reducer ordering  | `src/app/root-store/meta/meta-reducer-registry.ts` (`META_REDUCERS`) |

What the agent actually owns is the part that is genuinely missing from the app:
an orchestrator. The app gets its store, effects, DI, and persistence from
Angular + NgRx + IndexedDB, none of which exist in a Node main process.

The one substitution made so far: the app's `operationCaptureMetaReducer` is
swapped for an equivalent that pushes straight into the agent's store (the
app's version increments a counter drained by an NgRx effect). It keeps its slot
in the chain, so the ordering constraints the registry documents still hold.

## What is proven

`spike/headless-reducers.spike.ts` answers the feasibility question, and
`src/store/agent-store.spec.ts` locks the result in:

- Super Productivity's real reducers and meta-reducers run in **plain Node** —
  no Angular DI, no browser, no NgRx `Store`. They depend only on `@ngrx/store`
  and `@ngrx/entity`, which are plain JS.
- The real action creators already stamp `meta.entityType` / `entityId` /
  `opType`, so operations get their sync identity without the agent deriving it.
- A dispatched action reduces correctly **and** yields exactly one `Operation`
  with the `MultiEntityPayload` envelope the app's `convertOpToAction` unwraps.
- A replayed remote operation (`meta.isRemote`) applies to state but emits
  **no** operation — the invariant that stops two clients echoing one change
  forever.
- The vector clock advances per operation and merges remote clocks, so the next
  local operation is not spuriously concurrent with work already applied.

Run them:

```bash
cd apps/sp-bridge
node scripts/run-ts.mjs spike/headless-reducers.spike.ts   # feasibility
node scripts/run-ts.mjs src/test/run-all.ts                # 76 assertions
../../node_modules/.bin/tsc -p tsconfig.json --noEmit       # 0 errors
```

Run the typecheck even when the tests pass. `run-ts.mjs` transpiles without
type-checking, so a wrong import or a bad enum member shows up as `undefined` at
runtime rather than as a build error — that is how the invented
`INBOX_PROJECT_ID` constant survived long enough to be worth writing down.

## Building

```bash
cd apps/sp-bridge
npm run build          # dist/main.js + dist/electron/{main,preload}.js
npm run build:min      # minified (+ sourcemap)
npm run package        # bundle + electron-builder → release/*.exe
npm run icon           # regenerate build/icon.{png,ico}
```

Two self-contained CommonJS bundles, because the agent has two runtimes:

| Output                  | Runtime        | Use                         |
| ----------------------- | -------------- | --------------------------- |
| `dist/main.js`          | plain Node 20+ | servers, CI, `node main.js` |
| `dist/electron/main.js` | Electron       | the Windows desktop shell   |

Both run with **no `node_modules` and no repo checkout** (verified from an empty
directory). `electron` stays external: the desktop shell gets it from the runtime,
and keeping it external is what lets the plain-Node build run without Electron
installed at all.

### Windows installer

`npm run package` runs electron-builder against `electron-builder.yaml`
(NSIS, x64, per-user install, desktop + start-menu shortcuts). The config's
`files` lists `dist/electron/main.js`, `dist/electron/preload.js` and
`dist/electron/icon.png` — no source, and none of the agent's own dependency
tree, because the agent is already bundled. The preload rides beside the main
bundle because Electron loads it by path; the bundle check loads both.

Those two paths are not cosmetic: electron-builder's sanity check asserts the
`main` entry (`dist/electron/main.js`) is present in the archive, so a `files`
entry naming a path `scripts/build.mjs` never writes fails the build rather
than shipping a broken package. The icon must sit beside the bundle because
`src/electron/main.ts` reads it as `join(__dirname, 'icon.png')`.

Note on size: the unpacked app is ~360 MB, and essentially all of that is the
Electron runtime itself, not the agent. `app.asar` is ~3.8 MB, of which ~2.9 MB
is the agent bundle. electron-builder does additionally collect a handful of
stray packages from the repo root (it walks up for production `node_modules`,
and the agent declares none of its own), but that measures ~1 MB and it logs
"cannot find path for dependency" for the rest — not worth chasing. If the size
ever matters, the lever is dropping Electron for a plain Node package, not
trimming these entries.

The installer is **unsigned**, so Windows SmartScreen will warn on first run.
That is expected for a locally built artifact; a certificate is needed before
handing it to anyone else.

#### Logs: `<dataDir>\bridge.log`

The bridge has no terminal of its own, and a GUI Electron app on Windows has no
attached console, so every diagnostic would otherwise be discarded. The first
import in each entry points the console at **`bridge.log`** in the data
directory (`%APPDATA%\sp-bridge` by default, or wherever `SP_BRIDGE_DATA_DIR`
points), and `uncaughtException` / `unhandledRejection` are recorded there. The
error dialog names the file. This is the first place to look when the app does
not appear to launch. (Pre-rename installs used `agent.log` under
`sp-sync-agent`; both are moved over automatically — see below.)

GitHub Actions builds it on every push to `sp-bridge` that touches this
directory: [`.github/workflows/sp-bridge-windows.yml`](../../.github/workflows/sp-bridge-windows.yml).
It runs typecheck → tests → spike → icon → bundle → electron-builder, verifies
an `.exe` actually appeared, and uploads it as an artifact. A Windows binary
cannot be cross-built from Linux, hence a `windows-latest` runner.

Verified: the bundle boots from an empty directory, serves the API, enforces
auth and the `Host` check, writes operations, and after a restart replays them
(`replayed 3 operation(s)`) with the same client id, the same access token and a
continuing vector clock.

### Why a bundle and not `tsc`

The agent imports Super Productivity's own sources from `../../../src/app/**`
and the workspace packages through the `@sp/*` aliases. A `tsc` build either
refuses to emit those (they sit outside `rootDir`) or copies the whole Angular
app tree into `dist/`. esbuild inlines exactly the reachable graph — 573 modules
— and the result is one file.

`electron` stays external: the future tray/packaging layer requires it lazily,
and marking it external keeps this build runnable under plain `node` today.

### Two load-order requirements

Both are invisible until they fail, so they are enforced by import order in
`src/entry.ts` rather than by convention:

1. **`window` must exist before app modules are _evaluated_.** Several read
   browser globals at module scope (`app.constants.ts` runs
   `!!window.SUPAndroid` while loading). The install call therefore lives in its
   own module, `platform/headless-globals-install.ts`, imported first — an inline
   call between two imports would still run too late, because ES semantics hoist
   imports above statements.
2. **`@angular/compiler` must be evaluated before `@ngrx/store`.** Those packages
   are partially compiled and fall back to the JIT compiler, which a bundle never
   links.

The dev runner masked (1) by installing the globals itself before loading the
entry, so the bundle was the thing that caught it.

## Running it

```bash
cd apps/sp-bridge
SP_BRIDGE_PORT=3976 node scripts/run-ts.mjs src/main.ts
```

It prints the data directory, client id, replayed operation count, bound address
and access token. Then, from another shell:

```bash
TOKEN=<printed token>
curl -s localhost:3976/health
curl -s -X POST localhost:3976/tasks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Write the sync transport","timeEstimate":3600}'
curl -s 'localhost:3976/tasks' -H "Authorization: Bearer $TOKEN"
```

`SP_BRIDGE_DATA_DIR` overrides the data directory (default
`%APPDATA%/sp-bridge` on Windows, `~/.local/share/sp-bridge` elsewhere).
It is deliberately NOT Super Productivity's own profile: the two are separate
clients that happen to speak the same protocol. The pre-rename `SP_AGENT_*`
environment names are still honoured as a fallback.

Previously this project was named sp-sync-agent (directory, data directory
and `SP_AGENT_*` variables included). On first start with the new default, an
existing `sp-sync-agent` data directory is moved to `sp-bridge` intact —
client id, op log, token and log file — so no history or identity is lost. An
explicit `SP_BRIDGE_DATA_DIR` disables the migration.

Verified end to end: create a task and a subtask over HTTP, kill the process,
restart it — both tasks come back, the parent's `subTaskIds` link is rebuilt by
the CRUD meta-reducer during replay, the access token is unchanged, and the next
operation carries the next vector-clock counter rather than restarting at 1.

## Layout

```
src/
  entry.ts               bundle entry; enforces the load order (see Building)
  main.ts                wiring: op log → store → server
  platform/
    headless-globals.ts  browser globals app modules read at import time
    headless-globals-install.ts  side-effect module that installs them first
    agent-logging.ts     lowers the app's VERBOSE default for a service
  store/
    agent-state.ts       the RootState subset the agent holds + feature reducer
    root-reducer.ts      app's META_REDUCERS over the feature reducer
    agent-store.ts       dispatch / read / observe + capture + persist sink
  oplog/
    operation-factory.ts persistent action → sync Operation
    op-log-store.ts      durable append-only log (JSONL) + meta
    hydrate.ts           replay the log through the app's bulk-apply action
  archive/
    archive-store.ts     file-backed archived-task projection (archive.json)
  focus/
    focus-ticker.ts      1s headless tick + session-completion dispatch
  sync/
    sync-config.ts       sync.json + SP_BRIDGE_SYNC_* env overrides
    credential-store.ts  file-backed SuperSync credential port
    seq-storage.ts       file-backed lastServerSeq port
    provider.ts          SuperSyncProvider wiring for plain Node
    crypto.ts            op payload E2EE envelope (encrypt/decrypt batch)
    engine.ts            download → resolve → apply → upload cycles + LWW
  rest/
    access-token.ts      token generation, persistence, revocation
    server.ts            HTTP transport: auth, Host/Origin checks, limits
    router.ts            the REST routes
  test/
    harness.ts, run-all.ts
scripts/
  run-ts.mjs             TypeScript runner for dev/tests
  build.mjs              esbuild bundler
spike/                   feasibility spike
```

### A note on `scripts/run-ts.mjs`

The agent does not use vitest or esbuild. **This workspace's `node_modules` is
incomplete**: `@vitest/*` are empty directories, `@esbuild/linux-x64` is absent,
and `ts-node` cannot load (`@jridgewell/sourcemap-codec` missing). `run-ts.mjs`
therefore transpiles with the TypeScript compiler API and resolves the
workspace path aliases itself. Once the workspace install is repaired this can be
replaced with `vitest`.

The manifest carries build and packaging tooling only (see
[Dependencies](#dependencies) above): the `node_modules` gaps the runner works
around are a broken-workspace problem, not a missing-manifest one, so working
around them here rather than re-declaring the app's dependencies keeps the
single-copy invariant.

## Roadmap

Ordered by dependency. Each step is independently testable. Steps 1–4 are done.

1. ~~**Durable op log**~~ — append-only JSONL + `meta.json`, persisting
   `clientId` and the vector clock across restarts, replayed on boot. Compaction
   is deliberately absent: snapshots are full-state and the app's snapshot format
   is not something to hand-roll, so the log grows monotonically for now.
2. ~~**REST server**~~ — transport (bearer token, `Host`/`Origin` checks, body
   and concurrency caps, `ok`/`data`/`error` envelope) plus the task, project,
   tag, status and task-control routes. Two gaps, both explicit rather than
   faked: `/focus` returns `501` (no timer yet) and `?source=archived` returns an
   empty set (no archive store yet) instead of quietly returning active tasks.
3. ~~**SuperSync transport**~~ — `SuperSyncProvider` with a file-backed
   credential store (`sync.json`), a file-backed `storage` port
   (`sync-state.json`), and E2EE via `@sp/sync-core`. Download → resolve →
   apply → upload cycles run on a timer plus a debounced post-change trigger;
   `GET /sync/status` and `POST /sync/trigger` expose them. Proven against a
   real server: `e2e/two-bridges.e2e.ts` replicates A → server → B and
   converges concurrent edits (see below).
4. ~~**Conflict handling**~~ — detection mirrors the app (per-entity frontier,
   concurrent local ops, archive/delete-wins, crossing reconstruction) over
   `@sp/sync-core`'s LWW planner. Local winners synthesize a dominating LWW
   update in the app's exact wire shape; losers leave the pending set but stay
   in history. Server-side `CONFLICT_*` rejections run a bounded extra
   download → resolve → upload round.
5. ~~**Focus/timer slice**~~ — `GET /focus` mirrors the desktop response over
   the real focus-mode slice, driven by a 1s headless ticker dispatching the
   real `tick`; completion dispatches the real `completeFocusSession` (plus
   `incrementCycle` in Pomodoro mode, mirroring that effect). Session control
   (`POST /focus/start|pause|resume|stop`, `/focus/break/start`) is a bridge
   extension — the desktop API is read-only there — without which the timer
   could never run headless. Effect-driven follow-ups (sounds, dialogs, break
   auto-start, tracking pauses) and the session-to-task timeSpent flush stay
   out: a completed session does not write timeSpent.
6. ~~**Archive store**~~ — `POST /tasks/:id/archive` and `POST /tasks/:id/restore`
   over a file-backed `archive.json`, with `?source=archived` and `all`
   reading it; remote archive/restore/update ops mirror the app's
   `ArchiveOperationHandler` into the file during sync apply.
7. ~~**Electron shell + Windows packaging**~~ — done for the shell and the
   installer: `src/electron/main.ts` (tray, status window, single-instance lock)
   and an electron-builder NSIS config built by CI. Settings live in the
   desktop shell too: tray → Settings opens a window over a minimal preload
   bridge (`window.spBridge`, redacted reads, blank-means-unchanged writes)
   for the SuperSync URL / token / master password, sync cadence, and
   start-on-login (`app.setLoginItemSettings`).

### Sync configuration

`sync.json` in the data directory (created by hand or by provisioning):

```json
{
  "baseUrl": "https://sync.super-productivity.com",
  "accessToken": "<account token>",
  "encryptKey": "<E2EE secret, same semantics as the desktop client>",
  "isEncryptionEnabled": true,
  "syncIntervalMs": 60000,
  "syncOnLocalChange": true
}
```

Without an `accessToken` the bridge is a local-only REST server. Every field
has an `SP_BRIDGE_SYNC_*` environment override (`SP_BRIDGE_SYNC_BASE_URL`,
`SP_BRIDGE_SYNC_ACCESS_TOKEN`, `SP_BRIDGE_SYNC_MASTER_PASSWORD`, …); a
`masterPassword` (file or env) is promoted to a persisted `encryptKey` once
and never written itself. Encryption is mandatory — without a key the engine
refuses to run rather than pushing plaintext into an encrypted dataset.

There is no password login to redeem (the server uses magic links and
passkeys; tokens live ~365 days), so rotation is manual — by file, env, or
`POST /sync/config` (which also starts, stops, or retunes the engine without
a restart, and validates strictly: unknown fields fail rather than silently
disable sync):

```bash
TOKEN=<printed token>
curl -s localhost:3976/sync/config -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:3976/sync/config \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"accessToken":"<account token>","encryptKey":"<secret>"}'
```

Config responses carry presence flags (`accessTokenSet`), never secrets. The
engine detects the changed credentials, invalidates the provider's per-token
caches, and breaks through failure backoff immediately.

### Sync E2E

Needs the TEST_MODE server (loopback-bound, rate limits off). CI runs this on
every push to `sp-bridge` touching this directory
([`sp-bridge-sync-e2e.yml`](../../.github/workflows/sp-bridge-sync-e2e.yml),
ubuntu-latest — the installer job's Windows runners cannot host the compose
stack). Five legs, all E2EE-encrypted: A → server → B replication,
concurrent-edit convergence, archive replication, update-wins-over-delete,
and delete-wins:

```bash
docker compose -f docker-compose.yaml -f docker-compose.supersync.yaml up -d supersync
until curl -s http://localhost:1901/health > /dev/null; do sleep 1; done
cd apps/sp-bridge
npm run e2e:supersync
```

### Known scope risk

Full interop means the agent must apply remote operations for **every** entity
type a real client can sync, not just tasks/projects/tags — archiving, time
tracking and global config all carry state the agent would otherwise silently
drop, and a dropped op is divergence. ~~Step 3 is where this becomes concrete;
entity coverage should be settled before the transport is considered done.~~
Settled: the agent reduces all 18 registry entity types plus layout (see
`src/store/agent-state.ts`), so no remote op drops on a missing slice.

### Traps hit while building this

Recorded because each one produced a _plausible green build_ rather than an
error, which is the dangerous kind:

- **Meta-reducer composition direction.** NgRx composes with
  `compose(...metaReducers, reducerFactory)`, which is a `reduceRight` — so the
  FIRST entry is outermost. A left-to-right `reduce` still reduces, still looks
  right, but leaves the CRUD meta-reducer _outside_ the bulk applier, so replayed
  operations never reach the cross-entity reducers and a replay silently
  rebuilds an incomplete state. See the comment in `root-reducer.ts`.
- **Browser globals installed too late.** `installHeadlessGlobals()` ran inside
  `startAgent()`, but app modules read `window` while being _evaluated_. The dev
  runner installed them before loading the entry and hid this; only the bundle
  exposed it. ES hoists imports above statements, so the fix had to be a
  side-effect module imported first, not an inline call.
- **A dispatched action nobody persists.** The REST routes dispatch and discard
  the returned operations; state existed with no operation behind it. Fixed with
  a persist sink registered on the store at construction, so no new dispatch
  site can forget.
- **A stale persisted vector clock.** The store advances the clock; nothing wrote
  it back, so `meta.json` stayed at its boot value. Redundant until the log is
  ever truncated, then silently catastrophic.
- **`fetch` cannot set `Host`.** The DNS-rebinding test passed against a server
  with no Host check at all, because `fetch` drops the header. That test now
  uses a raw `http.request`.
- **An invented constant.** `INBOX_PROJECT_ID` does not exist (it is
  `INBOX_PROJECT.id`), and the transpile-only runner evaluated the bad import to
  `undefined` instead of failing — so the "Inbox exists" assertion was the only
  thing that caught it.
- **A rewritten `package.json` that silently dropped 8 dependencies.** Editing
  the manifest to add packaging tools replaced the dependency block; the packages
  were still in `node_modules`, so every local command kept working while a clean
  `npm ci` would have failed outright. Nothing in a dev loop can catch this —
  only reading the manifest back, or letting CI do a clean install.
- **Workspace aliases triplicated and drifting.** `tsconfig.json`,
  `scripts/run-ts.mjs` and `scripts/build.mjs` each carried their own copy. The
  scripts listed a subset, so `tsc` fell back to the `@sp/*` workspace symlinks
  in `node_modules` for the rest, found built `.d.mts` files, and reported errors
  in app sources the agent resolves fine. All three now read one map from
  `scripts/aliases.mjs`, which parses `tsconfig.json`.
- **A green local type-check that was green by accident.** The agent
  type-checks Super Productivity's own sources, so their bare imports
  (`@angular/core`, `rxjs`, `zod`, `typia`, `nanoid`, …) resolve by walking up
  from the importing file. Inside this git worktree that walk reaches the
  **parent checkout's** `node_modules`, a complete install — so everything
  passed locally while depending on a machine accident. The first CI run failed
  with hundreds of `Cannot find module` errors in app code, because a fresh
  runner has no such ancestor.
  Two wrong fixes were tried before the right one. Re-declaring the app's
  dependencies in the agent's `package.json` drifts immediately and would have
  put a second, divergent Angular copy on the type path. A `paths` catch-all
  pointing at the agent's own `node_modules` had the same shadowing hazard.
  The correct answer is the boring one: the agent is part of this repo and
  type-checks part of it, so CI installs the repo's dependencies
  (`npm ci --ignore-scripts` at the root) and the agent's manifest carries build
  tooling only.
- **A generated file, skipped by `--ignore-scripts`.** Skipping the root
  `prepare` chain also skips `npm run env`, which creates
  `src/app/config/env.generated.ts` — untracked, gitignored, and imported by
  `src/app/util/env.ts`. The first CI attempt at that change failed on exactly
  one missing module. `tools/load-env.js --ensure` is the purpose-built flag for
  this case, so the workflow now calls it explicitly instead of relying on the
  prepare chain. Confirmed by deleting the file locally and watching the same
  error appear, then re-creating it.
- **An installer that packaged cleanly and could not start.** The CI job went
  green and produced a 110 MB `.exe`, and the app still never appeared. Two
  independent bugs, both fatal at _require_ time — above `app.whenReady()` and
  outside the try/catch inside it, so there was no window, no tray, no dialog
  and no data directory:
  - `scripts/build.mjs`'s `aliasPlugin` matches every specifier, and an
    `onResolve` result takes precedence over esbuild's `external` option. It
    resolved `electron` to a real path, so `external: ['electron']` was silently
    inert and electron's own `index.js` got bundled in. That code then looked for
    the runtime binary under `…/app.asar/dist/electron/dist/electron`, found
    nothing, and threw _"Electron failed to install correctly"_. The plugin now
    consults the same `externalPackages` set before its resolve bias.
  - `src/electron/main.ts` was missing the two load-bearing imports that
    `src/entry.ts` has — `headless-globals-install` and `@angular/compiler` —
    so evaluating `../main` threw `ReferenceError: window is not defined`. The
    entry comments already explained why the order matters; the Electron entry
    had simply never been given them.
- **No logs, which is why the above took a day to find.** Every diagnostic goes
  through `console`, and a Windows GUI process has no console to go to. The
  first import in each entry now tees it to `<dataDir>/bridge.log`, and
  `uncaughtException` / `unhandledRejection` are recorded. Verified by rebuilding
  with the shim removed and reading the resulting stack trace out of the file.

  The general lesson: a green CI run on a GUI target proves the thing _packages_,
  not that it _launches_. Both bugs above were invisible to every gate in the
  workflow. Anything asserted only by `electron-builder` needs a check that
  actually loads the built bundle.

- **Downloaded ops re-entering the upload stream.** The op log interleaves
  local and downloaded remote ops, so an `uploadedCount` prefix cursor served
  the other client's ops back to the server, which rejects them with
  `INVALID_CLIENT_ID` (op.clientId ≠ request clientId). Pending upload is now
  a persisted id SET containing only locally-produced ops; remote applies
  never enter it.
- **The server rejects concurrent ops, so losers need compensation.** Leaving
  a `CONFLICT_CONCURRENT`-rejected op pending re-uploads (and re-rejects) it
  on every cycle — and under the old prefix cursor it wedged everything behind
  it. Local winners now synthesize a dominating LWW update in the app's exact
  wire shape; losers leave the pending set but stay in history. Found by the
  two-bridge E2E, which diverged before this existed.
- **Applied remote clocks must enter the store's own clock.** The engine
  merged them into the op-log meta but not the store, so the first local op
  after any download carried no remote causality, read as concurrent on the
  server, and was rejected. Every post-download local edit was unsyncable.
  Found by the archive leg of the two-bridge E2E (the first such op it ever
  uploaded).
- **A moveToArchive payload without `subTasks` crashes the reducer.** The
  lifecycle reducer maps over `task.subTasks` unconditionally, so the route
  normalizes childless tasks to `subTasks: []` (the action creator requires
  the full payload for exactly this reason).
- **A winning local delete needs a replacement op, not a shrug.** Skipping
  the remote update while leaving the original delete pending just earns
  another `CONFLICT_CONCURRENT` — and falling back to the remote side
  resurrects the task and drops the delete from the upload stream, diverging
  permanently. Local delete/archive wins now re-emit the original payload
  with a merged dominating clock (the app's replacement-delete shape).
- **A boxed reducer error kills a headless process.** The failure guard keeps
  state alive by design, but its dev-mode reporter (`devError` →
  `alert`/`confirm`) touches `document` and throws from a `setTimeout` after
  the recovery — taking the whole bridge down over an already-contained
  error. `headless-globals` stubs that dialog surface (alert → log,
  confirm → false) and nothing else.
- **Focus completion without the effects is half a feature.** The tick,
  the stop-at-duration transition, `completeFocusSession` and the Pomodoro
  `incrementCycle` are all reducer state and replay faithfully headless — but
  everything the desktop fans out through effects (break auto-start, tracking
  pauses, the timeSpent flush to the task) does not run, and reimplementing
  those would be parallel-domain drift. The timer reads live and controls
  work; time accounting stays a documented gap rather than a faked one.
