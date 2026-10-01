import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from '../test/harness';
import { startAgent, type StartedAgent } from '../main';

/**
 * Engine lifecycle through the real `POST /sync/config` path: provisioning
 * starts the engine without a restart, clearing the token stops it.
 * No network is touched (interval 0, no manual trigger).
 */
describe('Sync lifecycle via /sync/config', () => {
  it('starts and stops the engine without a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-bridge-lifecycle-'));
    let agent: StartedAgent | null = null;
    try {
      agent = await startAgent(dir, 0);
      assert.equal(agent.sync, null);
      const address = agent.server.address();
      if (!address) {
        throw new Error('server did not bind an address');
      }
      const base = `http://127.0.0.1:${address.port}`;
      const call = async (
        method: string,
        path: string,
        body?: unknown,
      ): Promise<{ status: number; body: any }> => {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${agent?.server.token}`,
            /* eslint-disable-next-line @typescript-eslint/naming-convention */
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as unknown };
      };

      assert.equal((await call('GET', '/sync/status')).body.data.enabled, false);

      const provisioned = await call('POST', '/sync/config', {
        accessToken: 'tok-0001',
        syncIntervalMs: 0,
      });
      assert.equal(provisioned.status, 200);
      assert.equal(provisioned.body.data.accessTokenSet, true);
      assert.equal(JSON.stringify(provisioned.body).includes('tok-0001'), false);
      assert.ok(agent.sync !== null, 'engine must start after provisioning');

      const cleared = await call('POST', '/sync/config', { accessToken: '' });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.data.accessTokenSet, false);
      assert.equal(agent.sync, null);
    } finally {
      await agent?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
