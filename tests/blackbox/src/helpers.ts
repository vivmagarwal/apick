import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createApp, silentLogger, type ApickApp, type ApickConfig } from '@apick/core';

/**
 * Black-box harness: every test boots a REAL app instance and talks to it over
 * HTTP (or MCP) exactly like an end user. No internal imports beyond the
 * public `createApp` entry point.
 */

export interface RunningApp {
  app: ApickApp;
  url: string;
  rootKey: string;
  stop: () => Promise<void>;
  api: ApiClient;
}

export async function startApp(config: Partial<ApickConfig> = {}): Promise<RunningApp> {
  const rootKey = `apick_test_${randomBytes(12).toString('base64url')}`;
  const app = await createApp({
    database: 'pglite://memory',
    rootKey,
    logger: silentLogger,
    pollIntervalMs: 25,
    tickIntervalMs: 100,
    ...config,
  });
  const { url } = await app.listen();
  return { app, url, rootKey, stop: () => app.stop(), api: new ApiClient(url, rootKey) };
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string | null = null,
    readonly tenant: string | null = null,
  ) {}

  with(options: { token?: string | null; tenant?: string | null }): ApiClient {
    return new ApiClient(
      this.baseUrl,
      options.token !== undefined ? options.token : this.token,
      options.tenant !== undefined ? options.tenant : this.tenant,
    );
  }

  async request(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    if (this.tenant) headers['x-apick-tenant'] = this.tenant;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  get(path: string): Promise<ApiResponse> {
    return this.request('GET', path);
  }
  post(path: string, body?: unknown): Promise<ApiResponse> {
    return this.request('POST', path, body);
  }
  patch(path: string, body?: unknown): Promise<ApiResponse> {
    return this.request('PATCH', path, body);
  }
  delete(path: string): Promise<ApiResponse> {
    return this.request('DELETE', path);
  }
}

export function filterQs(filter: unknown): string {
  return `filter=${encodeURIComponent(JSON.stringify(filter))}`;
}

/** Tiny local HTTP receiver for webhook tests. */
export interface Receiver {
  url: string;
  requests: Array<{ headers: Record<string, string | string[] | undefined>; body: string }>;
  respondWith: (status: number) => void;
  close: () => Promise<void>;
}

export async function startReceiver(): Promise<Receiver> {
  const requests: Receiver['requests'] = [];
  let status = 200;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ headers: req.headers, body });
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    respondWith: (s: number) => {
      status = s;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export async function eventually<T>(fn: () => Promise<T> | T, options: { timeoutMs?: number; intervalMs?: number; label?: string } = {}): Promise<T> {
  const timeout = options.timeoutMs ?? 10_000;
  const interval = options.intervalMs ?? 50;
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeout) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  throw new Error(`eventually(${options.label ?? 'condition'}) timed out after ${timeout}ms: ${String(lastError)}`);
}

/** Postgres url provided by global-setup when Docker is available. */
export function pgUrl(): string | null {
  return process.env['APICK_TEST_PG_URL'] ?? null;
}

let pgDbCounter = 0;

/** Create an isolated database on the shared test Postgres and return its url. */
export async function freshPgDatabase(): Promise<string> {
  const base = pgUrl();
  if (!base) throw new Error('No test Postgres available');
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: base });
  await client.connect();
  const name = `apick_test_${Date.now()}_${pgDbCounter++}`;
  await client.query(`create database ${name}`);
  await client.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}
