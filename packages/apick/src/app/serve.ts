import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';

type FetchHandler = (request: Request) => Response | Promise<Response>;

/**
 * Minimal Node HTTP bridge for a fetch-style handler (dependency-free).
 * APIck is a library you mount — this is only the convenience path for
 * `app.listen()`; in your own server just use `app.fetch`.
 */
export function serve(handler: FetchHandler, options: { port?: number; hostname?: string } = {}): Promise<{ server: Server; port: number; url: string }> {
  const server = createServer(async (req, res) => {
    try {
      const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const method = req.method ?? 'GET';
      const body = method === 'GET' || method === 'HEAD' ? undefined : (Readable.toWeb(req) as unknown as ReadableStream);
      const request = new Request(url, { method, headers, ...(body ? { body } : {}), duplex: 'half' } as RequestInit);
      const response = await handler(request);
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      res.writeHead(response.status, outHeaders);
      if (response.body) {
        Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal', message: String(err) } }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.hostname ?? '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
      resolve({ server, port, url: `http://${options.hostname ?? '127.0.0.1'}:${port}` });
    });
  });
}
