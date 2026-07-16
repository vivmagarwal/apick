import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, defineCollection, f, silentLogger } from '@apick/core';

/**
 * PROMISE: content-as-files — `apick content push|pull|check` moves markdown +
 * json content in and out of collections idempotently, resolving relations by
 * human key. Exercised the black-box way: the REAL CLI binary (node
 * dist/cli/index.js) run as a child process against a file-backed pglite db.
 */

const CLI = fileURLToPath(new URL('../../../packages/apick/dist/cli/index.js', import.meta.url));
const CORE = pathToFileURL(fileURLToPath(new URL('../../../packages/apick/dist/index.js', import.meta.url))).href;

const APP_MJS = `import { defineCollection, f } from '${CORE}';

export const collections = [
  defineCollection('writers', {
    fields: {
      name: f.text({ required: true, unique: true }),
      role: f.enum(['staff', 'guest']),
    },
  }),
  defineCollection('posts', {
    fields: {
      title: f.text({ required: true }),
      slug: f.slug({ unique: true }),
      body: f.markdown(),
      category: f.enum(['tech', 'life']),
      tags: f.list(f.text()),
      author: f.relation('writers'),
      order: f.integer({ default: 0 }),
    },
  }),
];
`;

// Same shapes, for in-process verification of what the CLI wrote.
function collections() {
  return [
    defineCollection('writers', {
      fields: { name: f.text({ required: true, unique: true }), role: f.enum(['staff', 'guest'] as const) },
    }),
    defineCollection('posts', {
      fields: {
        title: f.text({ required: true }),
        slug: f.slug({ unique: true }),
        body: f.markdown(),
        category: f.enum(['tech', 'life'] as const),
        tags: f.list(f.text()),
        author: f.relation('writers'),
        order: f.integer({ default: 0 }),
      },
    }),
  ];
}

const HELLO_MD = `---
title: Hello World
slug: hello-world
category: tech
tags:
  - alpha
  - beta
author: Ada
order: 2
---

Hello **world** body.
`;

const DRAFT_MD = `---
title: Draft Note
slug: draft-note
category: life
author: Ada
publish: false
---

Still cooking.
`;

function cli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('content-as-files CLI (push / pull / check)', () => {
  let tmp: string;
  let contentDir: string;
  let appPath: string;
  let dbUrl: string;
  let pushArgs: string[];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'apick-content-'));
    contentDir = join(tmp, 'content');
    appPath = join(tmp, 'app.mjs');
    dbUrl = `pglite://${join(tmp, 'db')}`;
    writeFileSync(appPath, APP_MJS);
    // posts/ sorts before writers.json — pushes exercise the two-pass
    // relation resolution (posts reference a writer that doesn't exist yet).
    mkdirSync(join(contentDir, 'posts'), { recursive: true });
    writeFileSync(join(contentDir, 'posts', 'hello-world.md'), HELLO_MD);
    writeFileSync(join(contentDir, 'posts', 'draft-note.md'), DRAFT_MD);
    writeFileSync(join(contentDir, 'writers.json'), JSON.stringify([{ name: 'Ada', role: 'staff' }], null, 2));
    pushArgs = ['content', 'push', contentDir, '--app', appPath, '--database', dbUrl];
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('push creates and publishes documents (relations resolved by human key)', async () => {
    const r = await cli(pushArgs, tmp);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('3 created · 0 updated · 0 unchanged · 2 published');

    // verify through a real app on the same database
    const app = await createApp({ database: dbUrl, collections: collections(), logger: silentLogger, worker: false });
    const { url } = await app.listen(0);
    try {
      const rootKey = app.rootKey; // fresh db + no configured key… root key was created by the CLI boot
      // The CLI deleted its ephemeral key, so a NEW root key is minted for us.
      expect(rootKey).toBeTruthy();
      const get = async (path: string) => {
        const res = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${rootKey}` } });
        return (await res.json()) as any;
      };
      const writers = await get('/v1/collections/writers/docs?status=draft');
      expect(writers.data).toHaveLength(1);
      expect(writers.data[0].data.name).toBe('Ada');
      expect(writers.data[0].publishedVersion).not.toBeNull();

      const posts = await get('/v1/collections/posts/docs?status=draft&sort=slug');
      expect(posts.data).toHaveLength(2);
      const draft = posts.data.find((d: any) => d.data.slug === 'draft-note');
      const hello = posts.data.find((d: any) => d.data.slug === 'hello-world');
      expect(draft.publishedVersion).toBeNull(); // publish: false stays draft
      expect(hello.publishedVersion).not.toBeNull();
      expect(hello.data.author).toBe(writers.data[0].docId); // human key → uuid
      expect(hello.data.body).toBe('Hello **world** body.\n');
      expect(hello.data.tags).toEqual(['alpha', 'beta']);
      expect(hello.data.order).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('second push is fully idempotent (all unchanged, nothing republished)', async () => {
    const r = await cli(pushArgs, tmp);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('0 created · 0 updated · 3 unchanged · 0 published');
  });

  it('editing one file yields exactly one update (+ republish)', async () => {
    writeFileSync(join(contentDir, 'posts', 'hello-world.md'), HELLO_MD.replace('Hello World', 'Hello Again'));
    const r = await cli(pushArgs, tmp);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('0 created · 1 updated · 2 unchanged · 1 published');
  });

  it('check catches a bad enum value and an unknown relation key (exit 1)', async () => {
    const bad = `---
title: Broken
slug: broken
category: bogus
author: Nobody
---

Body.
`;
    writeFileSync(join(contentDir, 'posts', 'broken.md'), bad);
    const r = await cli(['content', 'check', contentDir, '--app', appPath], tmp);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('posts/broken.md');
    expect(r.stderr).toContain('category');
    expect(r.stderr).toContain('unknown writers key "Nobody"');
    rmSync(join(contentDir, 'posts', 'broken.md'));

    const ok = await cli(['content', 'check', contentDir, '--app', appPath], tmp);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('3 document(s) OK');
  });

  it('pull round-trips: pull → push is all unchanged, with human keys + publish flags', async () => {
    const pulled = join(tmp, 'pulled');
    const r = await cli(['content', 'pull', pulled, '--app', appPath, '--database', dbUrl], tmp);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('3 document(s)');

    const hello = readFileSync(join(pulled, 'posts', 'hello-world.md'), 'utf8');
    expect(hello).toContain('author: Ada'); // uuid mapped back to the human key
    expect(hello).toContain('title: Hello Again');
    expect(hello).not.toContain('publish:'); // published docs carry no flag
    expect(hello.endsWith('Hello **world** body.\n')).toBe(true);
    const draft = readFileSync(join(pulled, 'posts', 'draft-note.md'), 'utf8');
    expect(draft).toContain('publish: false');
    const writers = JSON.parse(readFileSync(join(pulled, 'writers.json'), 'utf8'));
    expect(writers).toEqual([{ name: 'Ada', role: 'staff' }]);

    const again = await cli(['content', 'push', pulled, '--app', appPath, '--database', dbUrl], tmp);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('0 created · 0 updated · 3 unchanged · 0 published');
  });
});
