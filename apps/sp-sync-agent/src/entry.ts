/**
 * Bundle entry point.
 *
 * Import order here is load-bearing and must not be "tidied":
 *
 *  1. `./platform/agent-log-file` — points the console at
 *     `<dataDir>/agent.log` before anything can throw, so a failure during
 *     module evaluation is recorded rather than lost.
 *
 *  2. `./platform/headless-globals-install` — app modules read `window` at
 *     module-evaluation time, so the globals must exist before any of them is
 *     evaluated. It has to be its own module: ES semantics hoist imports above
 *     statements, so an inline `installHeadlessGlobals()` call would still run
 *     too late. See that file for the full explanation.
 *
 *  3. `@angular/compiler` — `@ngrx/store` and `@angular/core` ship partially
 *     compiled, declaring injectables via `ɵɵngDeclareFactory`, which falls
 *     back to the JIT compiler. A bundle is never AOT-linked, so without the
 *     compiler the first `@ngrx/store` import throws "needs to be compiled
 *     using the JIT compiler". The reducers never *use* DI; this only satisfies
 *     module initialisation.
 *
 *  4. `./main` — the app itself, which transitively pulls in the reducers.
 */
import './platform/agent-log-file';
import './platform/headless-globals-install';
import '@angular/compiler';

export { startAgent } from './main';
export type { StartedAgent } from './main';
