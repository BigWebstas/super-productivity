# sp-sync-agent

A small headless Windows agent that serves **Super Productivity's local REST API**
and syncs to a **SuperSync server**, with data that is interchangeable with the
real Super Productivity clients.

> **Status: runs, persists, and serves the API. Sync not yet enabled.** The
> agent boots, replays its operation log, serves the local REST API, and writes
> every mutation to disk as a Super Productivity–compatible operation. The
> SuperSync transport, conflict handling and the `/focus` timer are the
> remaining work, listed in [Roadmap](#roadmap).

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
cd apps/sp-sync-agent && npm ci  # the agent's build tooling
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
cd apps/sp-sync-agent
node scripts/run-ts.mjs spike/headless-reducers.spike.ts   # feasibility
node scripts/run-ts.mjs src/test/run-all.ts                # 59 assertions
../../node_modules/.bin/tsc -p tsconfig.json --noEmit       # 0 errors
```

Run the typecheck even when the tests pass. `run-ts.mjs` transpiles without
type-checking, so a wrong import or a bad enum member shows up as `undefined` at
runtime rather than as a build error — that is how the invented
`INBOX_PROJECT_ID` constant survived long enough to be worth writing down.

## Building

```bash
cd apps/sp-sync-agent
npm run build          # dist/main.js + dist/electron/main.js
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
`files` lists only `dist/electron/main.js` and `dist/electron/icon.png` — no
source, and none of the agent's own dependency tree, because the agent is
already bundled.

Those two paths are not cosmetic: electron-builder's sanity check asserts the
`main` entry (`dist/electron/main.js`) is present in the archive, so a `files`
entry naming a path `scripts/build.mjs` never writes fails the build rather
than shipping a broken package. The icon must sit beside the bundle because
`src/electron/main.ts` reads it as `join(__dirname, 'icon.png')`.

Note: electron-builder additionally copies production `node_modules` resolved
from the **repo root** into the archive, because the agent declares
`dependencies: {}` and so has no local collection for the collector to find —
it falls back to the workspace root. Those are dead weight (the bundle inlines
what it needs), but they do inflate the installer. Shrinking that means telling
electron-builder to skip node-module collection, which is a separate change.

The installer is **unsigned**, so Windows SmartScreen will warn on first run.
That is expected for a locally built artifact; a certificate is needed before
handing it to anyone else.

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
cd apps/sp-sync-agent
SP_AGENT_PORT=3976 node scripts/run-ts.mjs src/main.ts
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

`SP_AGENT_DATA_DIR` overrides the data directory (default
`%APPDATA%/sp-sync-agent` on Windows, `~/.local/share/sp-sync-agent` elsewhere).
It is deliberately NOT Super Productivity's own profile: the two are separate
clients that happen to speak the same protocol.

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

For the same reason the agent declares its own dependencies in
`apps/sp-sync-agent/package.json` (`@ngrx/store`, `@angular/core`, …) rather than
relying on the root install. **No root dependency was added** — per
`AGENTS.md`, these are all already root dependencies; they are simply not
installed here.

## Roadmap

Ordered by dependency. Each step is independently testable. Steps 1–2 are done.

1. ~~**Durable op log**~~ — append-only JSONL + `meta.json`, persisting
   `clientId` and the vector clock across restarts, replayed on boot. Compaction
   is deliberately absent: snapshots are full-state and the app's snapshot format
   is not something to hand-roll, so the log grows monotonically for now.
2. ~~**REST server**~~ — transport (bearer token, `Host`/`Origin` checks, body
   and concurrency caps, `ok`/`data`/`error` envelope) plus the task, project,
   tag, status and task-control routes. Two gaps, both explicit rather than
   faked: `/focus` returns `501` (no timer yet) and `?source=archived` returns an
   empty set (no archive store yet) instead of quietly returning active tasks.
3. **SuperSync transport** — wire `SuperSyncProvider` with a file-backed
   credential store and a file-backed `storage` port (the provider is
   host-agnostic by design), plus E2EE via `@sp/sync-core`.
4. **Conflict handling** — `@sp/sync-core` gives the algorithms; the agent needs
   the orchestration the app does in `conflict-resolution.service.ts`.
5. **Focus/timer slice** — `/focus` and `/status` timing need focus-mode state
   and a ticker.
6. **Archive store** — `POST /tasks/:id/archive` and `?source=archived`.
7. ~~**Electron shell + Windows packaging**~~ — done for the shell and the
   installer: `src/electron/main.ts` (tray, status window, single-instance lock)
   and an electron-builder NSIS config built by CI. Still open: a settings UI for
   the SuperSync URL / token / master password, and start-on-login.

### Known scope risk

Full interop means the agent must apply remote operations for **every** entity
type a real client can sync, not just tasks/projects/tags — archiving, time
tracking and global config all carry state the agent would otherwise silently
drop, and a dropped op is divergence. Step 3 is where this becomes concrete;
entity coverage should be settled before the transport is considered done.

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
