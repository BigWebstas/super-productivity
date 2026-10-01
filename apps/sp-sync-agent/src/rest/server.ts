/**
 * The local REST API's HTTP transport.
 *
 * A direct port of `electron/local-rest-api.ts`, minus the Electron specifics.
 * Two differences, both because the agent has no renderer:
 *  - Requests are routed in-process instead of being forwarded over IPC to the
 *    Angular app, so there is no renderer timeout and no `APP_NOT_READY` state.
 *  - Enabling/disabling is a constructor concern rather than a config-sync one.
 *
 * Everything security-relevant is preserved deliberately, because this is a
 * credentialed server on a machine that may run other accounts and a browser:
 *  - binds loopback only;
 *  - validates the `Host` header (DNS-rebinding defence);
 *  - rejects any web `Origin` (CSRF defence — browsers always set it on
 *    cross-origin writes, including simple `text/plain` POSTs that CORS does not
 *    preflight);
 *  - constant-time token comparison;
 *  - re-validates the token AFTER the body is read, so a leaked token cannot
 *    bank mutating requests by opening them and landing the body after a
 *    rotation;
 *  - caps body size and concurrent requests.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AccessTokenStore } from './access-token';

export const LOCAL_REST_API_HOST = '127.0.0.1';
export const LOCAL_REST_API_PORT = 3876;
export const LOCAL_REST_API_MAX_BODY_BYTES = 1024 * 1024;
export const LOCAL_REST_API_MAX_CONCURRENT_REQUESTS = 50;
/** Matches the app, so a script written against it needs no change. */
export const LOCAL_REST_API_TIMEOUT_MS = 15000;

const JSON_HEADERS = {
  /* eslint-disable-next-line @typescript-eslint/naming-convention */
  'Content-Type': 'application/json; charset=utf-8',
};

const ALLOWED_HOSTS = new Set([
  `${LOCAL_REST_API_HOST}:${LOCAL_REST_API_PORT}`,
  `localhost:${LOCAL_REST_API_PORT}`,
  LOCAL_REST_API_HOST,
  'localhost',
]);

/**
 * Allowed `Host` header values for a given bind address.
 *
 * The app hardcodes port 3876, so its set is a constant. The agent's port is
 * configurable (and 0 in tests, meaning "any free port"), so the effective port
 * is only known after binding — a fixed set would reject every request with 403
 * on any port but the default.
 */
const allowedHostsFor = (host: string, port: number): Set<string> => {
  const hosts = new Set(ALLOWED_HOSTS);
  hosts.add(`${host}:${port}`);
  hosts.add(`localhost:${port}`);
  if (!ALLOWED_HOSTS.has(host)) {
    hosts.add(host);
  }
  return hosts;
};

const BEARER_SCHEME = 'bearer';
const TOKEN_LOCATION_HINT = 'Find the token in the agent config directory.';

export interface RestRequest {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  body: unknown;
}

export interface RestResponse {
  status: number;
  body: unknown;
}

export type RouteHandler = (request: RestRequest) => Promise<RestResponse> | RestResponse;

export interface ServerOptions {
  dataDir: string;
  port?: number;
  host?: string;
  /** Test seam: skips binding a real socket. */
  onRequest?: RouteHandler;
}

const writeJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void => {
  const responseJson = JSON.stringify(body);
  res.writeHead(status, {
    ...JSON_HEADERS,
    /* eslint-disable-next-line @typescript-eslint/naming-convention */
    'Content-Length': Buffer.byteLength(responseJson),
    ...extraHeaders,
  });
  res.end(responseJson);
};

const errorBody = (code: string, message: string): unknown => ({
  ok: false,
  error: { code, message },
});

const successBody = (data: unknown): unknown => ({ ok: true, data });

/**
 * Pulls the credential out of `Authorization: Bearer <token>`.
 *
 * Scanned by hand rather than matched with a regex: the space run and the
 * credential can both match a space, so a failing input is retried at every
 * split of them. One left-to-right pass costs the same on every input.
 * Case-insensitive scheme (RFC 7235), at least one separating space, credential
 * is the rest of the header verbatim.
 */
export const parseBearerToken = (authHeader: string | undefined): string | undefined => {
  if (
    !authHeader ||
    authHeader.length <= BEARER_SCHEME.length ||
    authHeader.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME
  ) {
    return undefined;
  }
  let tokenStart = BEARER_SCHEME.length;
  while (tokenStart < authHeader.length && authHeader[tokenStart] === ' ') {
    tokenStart++;
  }
  if (tokenStart === BEARER_SCHEME.length || tokenStart === authHeader.length) {
    return undefined;
  }
  return authHeader.slice(tokenStart);
};

const compareToken = (input: string, expected: string): boolean => {
  const inputBuffer = Buffer.from(input, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (inputBuffer.length !== expectedBuffer.length) {
    // Dummy comparison so a length mismatch costs the same as a value mismatch.
    timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return timingSafeEqual(inputBuffer, expectedBuffer);
};

const getQueryObject = (url: URL): Record<string, string | string[]> => {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length <= 1 ? (values[0] ?? '') : values;
  }
  return query;
};

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bufferChunk.length;
    if (totalBytes > LOCAL_REST_API_MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(bufferChunk);
  }
  if (!chunks.length) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

export class LocalRestApiServer {
  private readonly _tokens: AccessTokenStore;
  private readonly _route: RouteHandler;
  private readonly _host: string;
  private readonly _port: number;
  private _server: Server | null = null;
  private _inFlight = 0;
  /**
   * Recomputed on every `listen()` from the address actually bound. Held on the
   * instance rather than derived per request so a request cannot observe a
   * half-initialised set.
   */
  private _allowedHosts: Set<string> = allowedHostsFor(
    LOCAL_REST_API_HOST,
    LOCAL_REST_API_PORT,
  );

  constructor(options: ServerOptions) {
    this._tokens = new AccessTokenStore(options.dataDir);
    this._route =
      options.onRequest ??
      (() => ({
        status: 501,
        body: errorBody('NOT_IMPLEMENTED', 'No route handler configured'),
      }));
    this._host = options.host ?? LOCAL_REST_API_HOST;
    this._port = options.port ?? LOCAL_REST_API_PORT;
  }

  get token(): string {
    return this._tokens.get();
  }

  /**
   * The bound address, or null when not listening.
   *
   * Needed because the port is configurable and tests bind port 0, so the
   * effective port is only known after `listen()`.
   */
  address(): { host: string; port: number } | null {
    const address = this._server?.address();
    if (!address || typeof address === 'string') {
      return null;
    }
    return { host: address.address, port: address.port };
  }

  async listen(): Promise<void> {
    if (this._server) {
      return;
    }
    this._server = createServer((req, res) => {
      void this._handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this._server?.once('error', reject);
      this._server?.listen(this._port, this._host, () => resolve());
    });
    const bound = this.address();
    if (bound) {
      this._allowedHosts = allowedHostsFor(bound.host, bound.port);
    }
  }

  async close(): Promise<void> {
    if (!this._server) {
      return;
    }
    const server = this._server;
    this._server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Keep-alive sockets would otherwise hold the close open indefinitely.
      server.closeAllConnections();
    });
  }

  private async _handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this._host}`);
    const method = req.method ?? 'GET';

    // DNS rebinding: a browser on another origin can be pointed at loopback, so
    // the Host header must be one we expect. Checked before /health too: the
    // endpoint exposes nothing, but there is no reason to serve even that to a
    // rebound host.
    const host = req.headers.host;
    if (!host || !this._allowedHosts.has(host)) {
      writeJson(res, 403, errorBody('FORBIDDEN', 'Invalid Host header'));
      return;
    }

    // Health is deliberately unauthenticated: it is how a script discovers
    // whether the agent is up before it has a token, and it exposes nothing.
    if (method === 'GET' && url.pathname === '/health') {
      writeJson(res, 200, successBody({ server: 'up', rendererReady: true }));
      return;
    }

    // CSRF: browsers always set Origin on cross-origin writes, including simple
    // text/plain POSTs that CORS does not preflight. CLI tools send none.
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      writeJson(
        res,
        403,
        errorBody('FORBIDDEN', 'Requests from web origins are not allowed'),
      );
      return;
    }

    if (this._inFlight >= LOCAL_REST_API_MAX_CONCURRENT_REQUESTS) {
      writeJson(
        res,
        429,
        errorBody(
          'TOO_MANY_REQUESTS',
          `Too many concurrent requests (limit: ${LOCAL_REST_API_MAX_CONCURRENT_REQUESTS})`,
        ),
      );
      return;
    }

    // Held across auth + body read + route: a slow body must count toward the
    // cap, or dripping request bodies bypasses the 429 entirely (slowloris).
    this._inFlight++;
    try {
      const presented = parseBearerToken(req.headers.authorization);
      if (presented === undefined) {
        this._respondUnauthorized(
          res,
          `Authorization token required — send "Authorization: Bearer <token>". ${TOKEN_LOCATION_HINT}`,
        );
        return;
      }
      if (!compareToken(presented, this._tokens.get())) {
        this._respondUnauthorized(
          res,
          `Invalid authorization token. ${TOKEN_LOCATION_HINT}`,
        );
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        writeJson(
          res,
          400,
          errorBody(
            'INVALID_REQUEST_BODY',
            error instanceof Error ? error.message : 'Invalid request body',
          ),
        );
        return;
      }

      // Re-checked after the body is in. A body can take arbitrarily long to
      // arrive, so without this whoever holds a leaked token can bank mutating
      // requests: open them, wait out a rotation, then let the bodies land —
      // breaking "regenerating invalidates the previous token immediately".
      if (!compareToken(presented, this._tokens.get())) {
        this._respondUnauthorized(
          res,
          `Invalid authorization token. ${TOKEN_LOCATION_HINT}`,
        );
        return;
      }

      try {
        const result = await this._route({
          method,
          path: url.pathname,
          query: getQueryObject(url),
          body,
        });
        writeJson(res, result.status, result.body);
      } catch (error) {
        writeJson(
          res,
          500,
          errorBody(
            'INTERNAL_ERROR',
            error instanceof Error ? error.message : 'Unknown internal error',
          ),
        );
      }
    } finally {
      this._inFlight--;
    }
  }

  private _respondUnauthorized(res: ServerResponse, message: string): void {
    writeJson(res, 401, errorBody('UNAUTHORIZED', message), {
      /* eslint-disable-next-line @typescript-eslint/naming-convention */
      'WWW-Authenticate': 'Bearer',
    });
  }
}

export { successBody, errorBody };
