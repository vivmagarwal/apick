import { execFileSync, execSync } from 'node:child_process';

/**
 * Starts one Postgres container for the whole run (replica + portability
 * tests need a real multi-connection Postgres; everything else runs on
 * embedded PGlite). If Docker is unavailable the PG-only tests skip.
 */
export default async function globalSetup(): Promise<() => void> {
  let containerId: string | null = null;
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 10_000 });
    containerId = execFileSync(
      'docker',
      [
        'run', '-d', '--rm',
        '-e', 'POSTGRES_USER=apick',
        '-e', 'POSTGRES_PASSWORD=apick',
        '-e', 'POSTGRES_DB=postgres',
        '-p', '127.0.0.1:0:5432',
        'postgres:16-alpine',
      ],
      { encoding: 'utf8', timeout: 60_000 },
    ).trim();
    const portLine = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8', timeout: 10_000 });
    const port = portLine.trim().split('\n')[0]!.split(':').pop()!;

    // wait for readiness
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        execFileSync('docker', ['exec', containerId, 'pg_isready', '-U', 'apick'], { stdio: 'ignore', timeout: 5_000 });
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!ready) throw new Error('postgres container did not become ready');

    process.env['APICK_TEST_PG_URL'] = `postgres://apick:apick@127.0.0.1:${port}/postgres`;
    console.log(`[blackbox] test postgres ready on port ${port}`);
  } catch (err) {
    if (containerId) {
      try {
        execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
      containerId = null;
    }
    console.warn(`[blackbox] no Docker postgres available — PG-only tests will skip (${String(err).split('\n')[0]})`);
  }

  return () => {
    if (containerId) {
      try {
        execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore', timeout: 30_000 });
      } catch {
        /* ignore */
      }
    }
  };
}
