/**
 * Test entry point. Imports every `*.spec.ts` and runs them.
 *
 * Specs self-register through the harness (see `harness.ts`), so adding a spec
 * means adding one import here.
 */
import { runAll } from './harness';

import '../store/agent-store.spec';
import '../oplog/operation-factory.spec';
import '../oplog/op-log-store.spec';
import '../rest/rest-api.spec';
import '../sync/sync-engine.spec';
import '../sync/sync-config.spec';
import '../sync/sync-lifecycle.spec';
import '../focus/focus-ticker.spec';

void runAll();
