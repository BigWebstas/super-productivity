import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { describe, it } from '../test/harness';
import { AgentStore } from '../store/agent-store';
import { createRouteHandler } from './router';
import { LocalRestApiServer, parseBearerToken } from './server';
import { SyncConfigValidationError } from '../sync/sync-config';
import { INBOX_PROJECT } from '../../../../src/app/features/project/project.const';
import { TASK_FEATURE_NAME } from '../../../../src/app/features/tasks/store/task.reducer';

/** Port 0 lets the OS pick a free port, so tests never collide. */
const withServer = async (
  fn: (ctx: {
    request: (
      method: string,
      path: string,
      opts?: { body?: unknown; token?: string | null; headers?: Record<string, string> },
    ) => Promise<{ status: number; body: any; headers: Headers }>;
    server: LocalRestApiServer;
    store: AgentStore;
    dir: string;
  }) => Promise<void>,
  overrides: {
    syncConfig?: {
      get: () => Record<string, unknown>;
      update: (patch: unknown) => Record<string, unknown>;
    };
  } = {},
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-bridge-rest-'));
  const store = new AgentStore('E_aaaaaa');
  const server = new LocalRestApiServer({
    dataDir: dir,
    port: 0,
    onRequest: createRouteHandler({
      store,
      syncConfig: overrides.syncConfig as never,
    }),
  });
  await server.listen();
  const address = server.address();
  if (!address) {
    throw new Error('server did not bind an address');
  }
  const base = `http://127.0.0.1:${address.port}`;

  const request = async (
    method: string,
    path: string,
    opts: {
      body?: unknown;
      token?: string | null;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const headers: Record<string, string> = { ...opts.headers };
    const token = opts.token === undefined ? server.token : opts.token;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
    };
  };

  try {
    await fn({ request, server, store, dir });
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

const taskById = (store: AgentStore, id: string): any =>
  (store.state[TASK_FEATURE_NAME] as unknown as { entities: Record<string, unknown> })
    .entities[id];

describe('parseBearerToken', () => {
  it('accepts the scheme case-insensitively with one or more spaces', () => {
    assert.equal(parseBearerToken('Bearer abc'), 'abc');
    assert.equal(parseBearerToken('bearer abc'), 'abc');
    assert.equal(parseBearerToken('BEARER abc'), 'abc');
    assert.equal(parseBearerToken('Bearer    abc'), 'abc');
  });

  it('rejects a missing scheme, a missing separator, and an empty credential', () => {
    assert.equal(parseBearerToken(undefined), undefined);
    assert.equal(parseBearerToken(''), undefined);
    assert.equal(parseBearerToken('abc'), undefined);
    assert.equal(parseBearerToken('Bearer'), undefined);
    assert.equal(parseBearerToken('Bearer '), undefined);
    assert.equal(parseBearerToken('Basic abc'), undefined);
  });

  it('keeps a credential containing spaces verbatim', () => {
    assert.equal(parseBearerToken('Bearer a b c'), 'a b c');
  });
});

describe('LocalRestApiServer transport', () => {
  it('serves /health without a token', async () => {
    await withServer(async ({ request }) => {
      const res = await request('GET', '/health', { token: null });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.server, 'up');
    });
  });

  it('rejects a request with no token, with a Bearer challenge', async () => {
    await withServer(async ({ request }) => {
      const res = await request('GET', '/status', { token: null });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
      // RFC 7235 requires a challenge on every 401.
      assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    });
  });

  it('rejects a wrong token', async () => {
    await withServer(async ({ request }) => {
      const res = await request('GET', '/status', { token: 'wrong-token-value' });
      assert.equal(res.status, 401);
    });
  });

  it('rejects an unexpected Host header (DNS rebinding)', async () => {
    await withServer(async ({ request, server }) => {
      // `fetch` silently drops an overridden `Host` (it is a forbidden header
      // name), so a request built with it would pass regardless of what the
      // server checks. A raw http.request can actually set it, which is the
      // whole point of the test.
      const port = server.address()!.port;
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/status',
            method: 'GET',
            headers: {
              Host: 'evil.example.com',
              Authorization: `Bearer ${server.token}`,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 403);

      // And the same request with a legitimate Host still works, so the check
      // is not simply rejecting everything.
      assert.equal((await request('GET', '/status')).status, 200);
    });
  });

  it('rejects a web Origin (CSRF)', async () => {
    await withServer(async ({ request }) => {
      const res = await request('POST', '/tasks', {
        body: { title: 'x' },
        headers: { Origin: 'https://evil.example.com' },
      });
      assert.equal(res.status, 403);
    });
  });

  it('reports an oversized body as a bad request rather than crashing', async () => {
    await withServer(async ({ request }) => {
      const res = await request('POST', '/tasks', {
        body: { title: 'x'.repeat(2 * 1024 * 1024) },
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_REQUEST_BODY');
    });
  });
});

describe('LocalRestApiServer routes', () => {
  it('creates a task and returns it with 201', async () => {
    await withServer(async ({ request, store }) => {
      const res = await request('POST', '/tasks', { body: { title: '  Buy milk  ' } });
      assert.equal(res.status, 201);
      assert.equal(res.body.ok, true);
      // Title is trimmed, and the task is linked to a real project.
      assert.equal(res.body.data.title, 'Buy milk');
      assert.equal(res.body.data.projectId, INBOX_PROJECT.id);
      assert.ok(taskById(store, res.body.data.id), 'task is in the store');
    });
  });

  it('rejects a create with no title', async () => {
    await withServer(async ({ request }) => {
      assert.equal((await request('POST', '/tasks', { body: {} })).status, 400);
      assert.equal(
        (await request('POST', '/tasks', { body: { title: '   ' } })).status,
        400,
      );
    });
  });

  it('rejects a non-string title rather than pushing it into state', async () => {
    await withServer(async ({ request }) => {
      const res = await request('POST', '/tasks', { body: { title: 42 } });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_INPUT');
    });
  });

  it('rejects subTaskIds on create and points at the supported path', async () => {
    await withServer(async ({ request }) => {
      const res = await request('POST', '/tasks', {
        body: { title: 'x', subTaskIds: ['a'] },
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'UNSUPPORTED_FIELD');
      assert.match(res.body.error.message, /parentId/);
    });
  });

  it('creates a subtask and inherits the parent project', async () => {
    await withServer(async ({ request }) => {
      const parent = await request('POST', '/tasks', { body: { title: 'Parent' } });
      const child = await request('POST', '/tasks', {
        body: { title: 'Child', parentId: parent.body.data.id },
      });
      assert.equal(child.status, 201);
      assert.equal(child.body.data.parentId, parent.body.data.id);
      assert.equal(child.body.data.projectId, INBOX_PROJECT.id);
    });
  });

  it('rejects inherited fields on a subtask create', async () => {
    await withServer(async ({ request }) => {
      const parent = await request('POST', '/tasks', { body: { title: 'Parent' } });
      const res = await request('POST', '/tasks', {
        body: { title: 'Child', parentId: parent.body.data.id, tagIds: ['T'] },
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'UNSUPPORTED_FIELD');
    });
  });

  it('rejects a subtask create with an unknown parent', async () => {
    await withServer(async ({ request }) => {
      const res = await request('POST', '/tasks', {
        body: { title: 'Child', parentId: 'does-not-exist' },
      });
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'PARENT_NOT_FOUND');
    });
  });

  it('lists tasks and filters by query, project and includeDone', async () => {
    await withServer(async ({ request }) => {
      await request('POST', '/tasks', { body: { title: 'Alpha' } });
      await request('POST', '/tasks', { body: { title: 'Beta' } });

      const all = await request('GET', '/tasks');
      assert.equal(all.status, 200);
      assert.equal(all.body.data.length, 2);

      const filtered = await request('GET', '/tasks?query=alph');
      assert.equal(filtered.body.data.length, 1);
      assert.equal(filtered.body.data[0].title, 'Alpha');

      const other = await request('GET', '/tasks?projectId=nope');
      assert.equal(other.body.data.length, 0);
    });
  });

  it('hides done tasks unless includeDone is set', async () => {
    await withServer(async ({ request }) => {
      const created = await request('POST', '/tasks', { body: { title: 'Done soon' } });
      await request('PATCH', `/tasks/${created.body.data.id}`, {
        body: { isDone: true },
      });

      assert.equal((await request('GET', '/tasks')).body.data.length, 0);
      assert.equal((await request('GET', '/tasks?includeDone=true')).body.data.length, 1);
    });
  });

  it('gets, patches and deletes a task', async () => {
    await withServer(async ({ request }) => {
      const created = await request('POST', '/tasks', { body: { title: 'Before' } });
      const id = created.body.data.id;

      const patched = await request('PATCH', `/tasks/${id}`, {
        body: { title: 'After', notes: 'note' },
      });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.data.title, 'After');
      assert.equal(patched.body.data.notes, 'note');

      assert.equal((await request('GET', `/tasks/${id}`)).body.data.title, 'After');

      const deleted = await request('DELETE', `/tasks/${id}`);
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.data.deleted, true);
      assert.equal((await request('GET', `/tasks/${id}`)).status, 404);
    });
  });

  it('rejects relational fields on PATCH', async () => {
    await withServer(async ({ request }) => {
      const created = await request('POST', '/tasks', { body: { title: 'x' } });
      for (const field of ['parentId', 'subTaskIds']) {
        const res = await request('PATCH', `/tasks/${created.body.data.id}`, {
          body: { [field]: 'y' },
        });
        assert.equal(res.status, 400, `${field} must be rejected`);
        assert.equal(res.body.error.code, 'UNSUPPORTED_FIELD');
      }
    });
  });

  it('rejects a badly typed field on PATCH', async () => {
    await withServer(async ({ request }) => {
      const created = await request('POST', '/tasks', { body: { title: 'x' } });
      const res = await request('PATCH', `/tasks/${created.body.data.id}`, {
        body: { timeEstimate: 'abc' },
      });
      assert.equal(res.status, 400);
    });
  });

  it('rejects a malformed dueDay', async () => {
    await withServer(async ({ request }) => {
      const created = await request('POST', '/tasks', { body: { title: 'x' } });
      const res = await request('PATCH', `/tasks/${created.body.data.id}`, {
        body: { dueDay: '01-01-2020' },
      });
      assert.equal(res.status, 400);
    });
  });

  it('rejects setting both deadlineDay and deadlineWithTime', async () => {
    await withServer(async ({ request }) => {
      const res = await request('POST', '/tasks', {
        body: {
          title: 'x',
          deadlineDay: '2030-01-01',
          deadlineWithTime: Date.now() + 1000,
        },
      });
      assert.equal(res.status, 400);
    });
  });

  it('sets and then removes a deadline', async () => {
    await withServer(async ({ request }) => {
      const created = await request('POST', '/tasks', { body: { title: 'x' } });
      const id = created.body.data.id;

      const set = await request('PATCH', `/tasks/${id}`, {
        body: { deadlineDay: '2030-06-01' },
      });
      assert.equal(set.status, 200);
      assert.equal(set.body.data.deadlineDay, '2030-06-01');

      const removed = await request('PATCH', `/tasks/${id}`, {
        body: { deadlineDay: null },
      });
      assert.equal(removed.status, 200);
      assert.equal(removed.body.data.deadlineDay, undefined);
    });
  });

  it('404s a PATCH on an unknown task', async () => {
    await withServer(async ({ request }) => {
      const res = await request('PATCH', '/tasks/nope', { body: { title: 'x' } });
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'TASK_NOT_FOUND');
    });
  });

  it('does not resolve a prototype property name as a task', async () => {
    await withServer(async ({ request }) => {
      // An entity-map lookup would find Object.prototype.constructor and return
      // a truthy non-task.
      for (const id of ['constructor', 'toString', '__proto__']) {
        assert.equal((await request('GET', `/tasks/${id}`)).status, 404, id);
      }
    });
  });

  it('starts, reports and stops the current task', async () => {
    await withServer(async ({ request }) => {
      const created = await request('POST', '/tasks', { body: { title: 'Focus me' } });
      const id = created.body.data.id;

      const started = await request('POST', `/tasks/${id}/start`);
      assert.equal(started.status, 200);
      assert.equal(started.body.data.currentTaskId, id);

      const status = await request('GET', '/status');
      assert.equal(status.body.data.currentTaskId, id);
      assert.equal(status.body.data.taskCount, 1);

      const current = await request('GET', '/task-control/current');
      assert.equal(current.body.data.id, id);

      const stopped = await request('POST', '/task-control/stop');
      assert.equal(stopped.body.data.currentTaskId, null);
      assert.equal((await request('GET', '/status')).body.data.currentTaskId, null);
    });
  });

  it('sets the current task via task-control and validates the id', async () => {
    await withServer(async ({ request }) => {
      const created = await request('POST', '/tasks', { body: { title: 'x' } });
      const id = created.body.data.id;

      assert.equal(
        (await request('POST', '/task-control/current', { body: { taskId: id } })).status,
        200,
      );
      assert.equal(
        (await request('POST', '/task-control/current', { body: { taskId: 'nope' } }))
          .status,
        404,
      );
      assert.equal(
        (await request('POST', '/task-control/current', { body: { taskId: 7 } })).status,
        400,
      );
      assert.equal(
        (await request('POST', '/task-control/current', { body: { taskId: null } }))
          .status,
        200,
      );
    });
  });

  it('lists projects and tags', async () => {
    await withServer(async ({ request }) => {
      const projects = await request('GET', '/projects');
      assert.equal(projects.status, 200);
      assert.ok(
        projects.body.data.some((p: { id: string }) => p.id === INBOX_PROJECT.id),
        'Inbox is listed',
      );

      const tags = await request('GET', '/tags');
      assert.equal(tags.status, 200);
      assert.ok(Array.isArray(tags.body.data));
    });
  });

  it('404s an unknown route and 501s the unimplemented focus route', async () => {
    await withServer(async ({ request }) => {
      const notFound = await request('GET', '/nope');
      assert.equal(notFound.status, 404);
      assert.equal(notFound.body.error.code, 'NOT_FOUND');

      const focus = await request('GET', '/focus');
      assert.equal(focus.status, 501);
    });
  });

  it('reports archived source as empty rather than returning active tasks', async () => {
    await withServer(async ({ request }) => {
      await request('POST', '/tasks', { body: { title: 'Active one' } });
      const archived = await request('GET', '/tasks?source=archived');
      // Better an honest empty set than the wrong one.
      assert.equal(archived.body.data.length, 0);
    });
  });

  it('accepts numeric timestamps and rejects string ones', async () => {
    await withServer(async ({ request }) => {
      const okRes = await request('POST', '/tasks', {
        body: { title: 'timed', dueWithTime: Date.now() + 3_600_000 },
      });
      assert.equal(okRes.status, 201);
      assert.equal(typeof okRes.body.data.dueWithTime, 'number');

      const badRes = await request('POST', '/tasks', {
        body: { title: 'bad', dueWithTime: 'tomorrow' },
      });
      assert.equal(badRes.status, 400);
      assert.equal(badRes.body.error.code, 'INVALID_INPUT');
    });
  });

  it('rejects creating a task in an unknown project', async () => {
    await withServer(async ({ request }) => {
      const res = await request('POST', '/tasks', {
        body: { title: 'orphan', projectId: 'does-not-exist' },
      });
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'PROJECT_NOT_FOUND');
    });
  });

  it('rejects an unknown task source instead of answering with the wrong set', async () => {
    await withServer(async ({ request }) => {
      const res = await request('GET', '/tasks?source=bogus');
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_INPUT');
    });
  });

  it('includes dueWithTime tasks in the virtual TODAY set', async () => {
    await withServer(async ({ request }) => {
      const created = await request('POST', '/tasks', {
        body: { title: 'today ts', dueWithTime: Date.now() + 3_600_000 },
      });
      assert.equal(created.status, 201);
      const today = await request('GET', '/tasks?tagId=TODAY&includeDone=true');
      assert.ok(
        (today.body.data as unknown[]).some(
          (t: unknown) =>
            (t as { id: string }).id === (created.body.data as { id: string }).id,
        ),
        'dueWithTime task must appear under TODAY',
      );
    });
  });
});

describe('Sync config routes', () => {
  it('409s config routes without a config provider', async () => {
    await withServer(async ({ request }) => {
      assert.equal((await request('GET', '/sync/config')).status, 409);
      assert.equal((await request('POST', '/sync/config', { body: {} })).status, 409);
    });
  });

  it('serves redacted config, applies patches, rejects typos', async () => {
    let stored: Record<string, unknown> = { accessToken: 'tok-0001' };
    const syncConfig = {
      get: () => ({ accessTokenSet: !!stored.accessToken }),
      update: (patch: unknown) => {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new SyncConfigValidationError('Config body must be a JSON object');
        }
        if ('accesToken' in (patch as Record<string, unknown>)) {
          throw new SyncConfigValidationError('Unknown config field(s): accesToken');
        }
        stored = { ...stored, ...(patch as Record<string, unknown>) };
        return { accessTokenSet: !!stored.accessToken };
      },
    };
    await withServer(
      async ({ request }) => {
        const get = await request('GET', '/sync/config');
        assert.equal(get.status, 200);
        assert.equal(get.body.data.accessTokenSet, true);
        assert.equal(JSON.stringify(get.body).includes('tok-0001'), false);

        const typo = await request('POST', '/sync/config', {
          body: { accesToken: 'x' },
        });
        assert.equal(typo.status, 400);
        assert.equal(typo.body.error.code, 'INVALID_INPUT');

        const patched = await request('POST', '/sync/config', {
          body: { syncIntervalMs: 5000 },
        });
        assert.equal(patched.status, 200);

        const nonObject = await request('POST', '/sync/config', { body: 42 });
        assert.equal(nonObject.status, 400);
      },
      { syncConfig },
    );
  });
});
