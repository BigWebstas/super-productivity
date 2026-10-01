/**
 * Two-bridge sync E2E against a real SuperSync server.
 *
 * Prerequisites (TEST_MODE server with a loopback-bound port):
 *
 *   docker compose -f docker-compose.yaml -f docker-compose.supersync.yaml up -d supersync
 *   until curl -s http://localhost:1901/health > /dev/null; do sleep 1; done
 *
 * Run:
 *
 *   SP_BRIDGE_E2E_BASE_URL=http://127.0.0.1:1901 \
 *     node scripts/run-ts.mjs e2e/two-bridges.e2e.ts
 *
 * Flow: create account via the test route → bridge A creates a task over its
 * REST API → A syncs → B syncs → B sees the task → concurrent edits on both
 * sides → sync A, sync B, sync A → both stores converge to the same title.
 * Exits non-zero with a diagnostic on the first mismatch.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgent } from '../src/main';

const BASE_URL = process.env.SP_BRIDGE_E2E_BASE_URL ?? 'http://127.0.0.1:1901';
const ENCRYPT_KEY = 'e2e-shared-key-0001';

const fail = (message: string): never => {
  console.error(`E2E FAIL: ${message}`);
  process.exit(1);
};

const main = async (): Promise<void> => {
  // 1. Account.
  const email = `bridge-e2e-${Date.now()}@example.com`;
  const userRes = await fetch(`${BASE_URL}/api/test/create-user`, {
    method: 'POST',
    headers: {
      /* eslint-disable-next-line @typescript-eslint/naming-convention */
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password: 'password-0001' }),
  });
  if (!userRes.ok) {
    fail(`create-user returned ${userRes.status}`);
  }
  const { token } = (await userRes.json()) as { token: string };
  if (!token) {
    fail('create-user returned no token');
  }

  // 2. Two bridges on one account.
  const dirA = mkdtempSync(join(tmpdir(), 'sp-bridge-e2e-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'sp-bridge-e2e-b-'));
  const syncJson = JSON.stringify({
    baseUrl: BASE_URL,
    accessToken: token,
    encryptKey: ENCRYPT_KEY,
    isEncryptionEnabled: true,
    syncIntervalMs: 0,
    syncOnLocalChange: false,
  });
  writeFileSync(join(dirA, 'sync.json'), syncJson);
  writeFileSync(join(dirB, 'sync.json'), syncJson);

  const agentA = await startAgent(dirA, 0);
  const agentB = await startAgent(dirB, 0);
  if (!agentA.sync || !agentB.sync) {
    fail('sync engine did not start on both bridges');
  }
  // The startup syncs fire in the background; wait them out, then drive.
  await new Promise((r) => setTimeout(r, 2000));

  const api = async (
    agent: typeof agentA,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{
    status: number;
    body: { ok: boolean; data?: never; error?: { code: string } };
  }> => {
    const address = agent.server.address();
    const res = await fetch(`http://127.0.0.1:${address?.port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${agent.server.token}`,
        /* eslint-disable-next-line @typescript-eslint/naming-convention */
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as never };
  };

  try {
    // 3. A creates → A syncs → B syncs → B sees it.
    const created = await api(agentA, 'POST', '/tasks', { title: 'E2E task' });
    if (created.status !== 201) {
      fail(`A create returned ${created.status}`);
    }
    const taskId = (created.body.data as { id: string }).id;
    await agentA.sync.syncNow('e2e-a-upload');
    await agentB.sync.syncNow('e2e-b-download');
    const onB = await api(agentB, 'GET', `/tasks/${taskId}`);
    if (onB.status !== 200 || (onB.body.data as { title: string }).title !== 'E2E task') {
      fail(`B does not see A's task: ${onB.status} ${JSON.stringify(onB.body)}`);
    }
    console.log('E2E: A → server → B OK');

    // 4. Concurrent edits, B last (B wins everywhere deterministically).
    await api(agentA, 'PATCH', `/tasks/${taskId}`, { title: 'A edit' });
    await new Promise((r) => setTimeout(r, 50));
    await api(agentB, 'PATCH', `/tasks/${taskId}`, { title: 'B edit' });
    await agentA.sync.syncNow('e2e-a-upload-edit');
    await agentB.sync.syncNow('e2e-b-resolve');
    await agentA.sync.syncNow('e2e-a-converge');

    const finalA = (await api(agentA, 'GET', `/tasks/${taskId}`)).body.data as {
      title: string;
    };
    const finalB = (await api(agentB, 'GET', `/tasks/${taskId}`)).body.data as {
      title: string;
    };
    if (finalA.title !== 'B edit' || finalB.title !== 'B edit') {
      fail(`diverged after concurrent edits: A=${finalA.title} B=${finalB.title}`);
    }
    console.log('E2E: concurrent edits converge OK');

    // 5. A archives → both sync → B's archive file has it, active does not.
    const archived = await api(agentA, 'POST', `/tasks/${taskId}/archive`);
    if (archived.status !== 200) {
      fail(`A archive returned ${archived.status}`);
    }
    await agentA.sync.syncNow('e2e-a-upload-archive');
    await agentB.sync.syncNow('e2e-b-download-archive');
    const bActive = await api(agentB, 'GET', `/tasks/${taskId}`);
    const bArchived = await api(agentB, 'GET', '/tasks?source=archived');
    if (bActive.status !== 404) {
      fail('B still has the archived task active');
    }
    if (
      (bArchived.body.data as { id: string }[]).some((t) => t.id !== taskId) ||
      (bArchived.body.data as { id: string }[]).length !== 1
    ) {
      fail(`B archive mismatch: ${JSON.stringify(bArchived.body)}`);
    }
    console.log('E2E: archive replication OK');

    // 6. Update-wins-over-delete: A deletes, B concurrently updates newer.
    const race = await api(agentA, 'POST', '/tasks', { title: 'Race' });
    const raceId = (race.body.data as { id: string }).id;
    await agentA.sync.syncNow('e2e-a-upload-race');
    await agentB.sync.syncNow('e2e-b-download-race');
    await api(agentA, 'DELETE', `/tasks/${raceId}`);
    await new Promise((r) => setTimeout(r, 100));
    await api(agentB, 'PATCH', `/tasks/${raceId}`, { title: 'B wins' });
    await agentA.sync.syncNow('e2e-a-upload-delete');
    await agentB.sync.syncNow('e2e-b-resolve-delete');
    await agentA.sync.syncNow('e2e-a-converge-delete');
    const raceA = (await api(agentA, 'GET', `/tasks/${raceId}`)).body.data as {
      title: string;
    };
    const raceB = (await api(agentB, 'GET', `/tasks/${raceId}`)).body.data as {
      title: string;
    };
    if (!raceA || raceA.title !== 'B wins' || !raceB || raceB.title !== 'B wins') {
      fail(`update-over-delete diverged: A=${raceA?.title} B=${raceB?.title}`);
    }
    console.log('E2E: update-wins-over-delete OK');

    // 7. Delete-wins: A updates, B concurrently deletes newer.
    await api(agentA, 'PATCH', `/tasks/${raceId}`, { title: 'A edit' });
    await new Promise((r) => setTimeout(r, 100));
    await api(agentB, 'DELETE', `/tasks/${raceId}`);
    await agentA.sync.syncNow('e2e-a-upload-edit2');
    await agentB.sync.syncNow('e2e-b-resolve-edit2');
    await agentA.sync.syncNow('e2e-a-converge-edit2');
    const goneA = await api(agentA, 'GET', `/tasks/${raceId}`);
    const goneB = await api(agentB, 'GET', `/tasks/${raceId}`);
    if (goneA.status !== 404 || goneB.status !== 404) {
      fail(`delete-wins diverged: A=${goneA.status} B=${goneB.status}`);
    }
    console.log('E2E: delete-wins OK');
    console.log('E2E PASS');
  } finally {
    await agentA.stop();
    await agentB.stop();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
};

void main().catch((error: unknown) => {
  console.error('E2E ERROR', error);
  process.exit(1);
});
