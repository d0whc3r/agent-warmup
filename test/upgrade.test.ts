import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { latestTag } from '../src/upgrade.js';
import { VERSION } from '../src/version.js';
import { sandbox } from './helpers/sandbox.js';

// `upgrade` reinstalls from the GitHub Release, so the two things worth pinning are
// the release lookup (what tag do we compare against?) and the guard that keeps a
// source/npm run from trying to overwrite a binary it does not own.

// Swap global fetch for the duration of one call; every path here consumes it once.
async function withFetch<T>(reply: () => Response, body: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = async () => reply();
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
}

test('latestTag reads tag_name from the latest release', async () => {
  const tag = await withFetch(
    () => Response.json({ tag_name: 'v9.9.9', name: 'ignored' }),
    () => latestTag(),
  );
  assert.equal(tag, 'v9.9.9');
});

test('latestTag reports an unusable answer instead of guessing a tag', async () => {
  await assert.rejects(
    withFetch(() => new Response('nope', { status: 403, statusText: 'rate limited' }), latestTag),
    /403 rate limited/,
  );
  await assert.rejects(
    withFetch(() => Response.json({}), latestTag),
    /no tag/,
  );
});

test('version prints the version compiled into the CLI', () => {
  const s = sandbox();
  const result = s.run('version');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), VERSION);
  // The compiled version is package.json's, which semantic-release bumps.
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
  assert.equal(VERSION, pkg.version);
  assert.equal(s.run('--version').stdout.trim(), VERSION);
});

// Running from source or from npm means process.execPath is node, not the binary:
// installing over it would drop a release binary next to the node runtime.
test('upgrade refuses to run when this is not a release binary', () => {
  const s = sandbox();
  const result = s.run('upgrade');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /binary installed from a GitHub Release/);
  assert.match(result.stderr, /install\.sh/);
});
