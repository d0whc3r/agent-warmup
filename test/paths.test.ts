import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// A throwaway home, set before paths.js is imported: WARMUP_HOME is resolved once
// at module load, and the ARM_SCRIPT fallback writes under it.
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-paths-'));
process.env.WARMUP_HOME = HOME_DIR;
const { expandHome, ARM_SCRIPT, ARM_SCRIPT_SRC, WARMUP_HOME } = await import('../src/paths.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli.ts');

test('expandHome only rewrites a leading ~, never a bare prefix match', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/.local/bin/claude'), path.join(os.homedir(), '.local/bin/claude'));
  assert.equal(expandHome('/usr/local/bin/claude'), '/usr/local/bin/claude');
  assert.equal(expandHome('claude'), 'claude');
  // "~user" is another user's home in shell, not ours — leave it alone.
  assert.equal(expandHome('~other/bin/claude'), '~other/bin/claude');
});

test('ARM_SCRIPT prefers the shipped source, falls back under WARMUP_HOME', () => {
  // codex ships its own script in the source tree…
  assert.equal(ARM_SCRIPT('codex'), ARM_SCRIPT_SRC('codex'));
  assert.ok(fs.existsSync(ARM_SCRIPT('codex')));
  // …zai reuses the opencode script, so there is no arm-zai.sh to point at and the
  // runtime copy under WARMUP_HOME is used instead.
  assert.equal(ARM_SCRIPT('zai'), path.join(WARMUP_HOME, 'arm-zai.sh'));
});

test('WARMUP_<ID>_SCRIPT overrides the arm script path (the test stub seam)', () => {
  process.env.WARMUP_KIMI_SCRIPT = '/tmp/stub.sh';
  try {
    assert.equal(ARM_SCRIPT('kimi'), '/tmp/stub.sh');
  } finally {
    delete process.env.WARMUP_KIMI_SCRIPT;
  }
  assert.equal(ARM_SCRIPT('kimi'), ARM_SCRIPT_SRC('kimi'));
});

// SELF_INVOCATION is what a plist/crontab line re-invokes. Reading it needs a fresh
// process, because it is derived from that process's own argv[1].
function selfInvocation(entryName: string): string[] {
  // Under node_modules so the throwaway entry stays out of the coverage report
  // (child processes inherit NODE_V8_COVERAGE no matter what env we hand them).
  const scratch = path.join(ROOT, 'node_modules', '.cache', 'agent-warmup-tests');
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'entry-'));
  // The real entries live in an ESM package; a .ts file outside one is loaded as
  // CJS by tsx, which is not the shape we are pinning down here.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  const entry = path.join(dir, entryName);
  const pathsUrl = new URL('../src/paths.js', import.meta.url).href;
  fs.writeFileSync(
    entry,
    `import { SELF_INVOCATION } from ${JSON.stringify(pathsUrl)};\n` +
      'process.stdout.write(JSON.stringify(SELF_INVOCATION));\n',
  );
  const r = spawnSync(process.execPath, ['--import', 'tsx', entry], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('a .ts entry re-invokes itself through the tsx loader, a bundled entry does not', () => {
  // Plain `node src/cli.ts` cannot load TypeScript, so a plist generated from
  // `pnpm dev` has to carry the loader or the scheduled tick dies silently.
  const dev = selfInvocation('cli.ts');
  assert.equal(dev[0], process.execPath);
  assert.equal(dev[1], '--import');
  assert.match(dev[2] ?? '', /tsx/);
  assert.match(dev[3] ?? '', /cli\.ts$/);
  // The published bundle is plain ESM: node + entry, nothing else.
  const bundled = selfInvocation('agent-warmup.mjs');
  assert.equal(bundled.length, 2);
  assert.equal(bundled[0], process.execPath);
  assert.match(bundled[1] ?? '', /agent-warmup\.mjs$/);
});

// migrateLegacyHome() moves a real directory, so it is only ever exercised in a
// child process with a fake HOME. The happy path lives in cli.test.ts; these are
// the two ways it must decline to move anything.
function runCli(env: NodeJS.ProcessEnv) {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env };
  if (!env.WARMUP_HOME) delete e.WARMUP_HOME;
  return spawnSync(process.execPath, ['--import', 'tsx', CLI, 'help'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: e,
  });
}

function fakeHomeWithLegacy(): { home: string; legacy: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-legacy-'));
  const legacy = path.join(home, '.claude', 'warmup');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'warmup.env'), 'WARMUP_MODE=fixed\n');
  return { home, legacy };
}

test('the legacy home is left alone once the neutral home already exists', () => {
  const { home, legacy } = fakeHomeWithLegacy();
  fs.mkdirSync(path.join(home, '.agent-warmup'), { recursive: true });
  const result = runCli({ HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /moved/);
  assert.ok(fs.existsSync(legacy), 'the legacy dir is not touched');
});

test('an explicit WARMUP_HOME disables the legacy migration entirely', () => {
  const { home, legacy } = fakeHomeWithLegacy();
  const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-explicit-'));
  const result = runCli({ HOME: home, WARMUP_HOME: explicit });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /moved/);
  assert.ok(fs.existsSync(legacy));
  assert.ok(result.stdout.includes(path.join(explicit, 'warmup.env')));
});
