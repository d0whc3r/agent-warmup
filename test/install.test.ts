import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const INSTALL_SH = fileURLToPath(new URL('../install.sh', import.meta.url));
const README = fileURLToPath(new URL('../README.md', import.meta.url));

function runInstall(
  args: string[],
  env: NodeJS.ProcessEnv,
  extra?: { stubs?: Record<string, string> },
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-install-'));
  const stubDir = path.join(tmp, 'stubs');
  fs.mkdirSync(stubDir);
  for (const [name, body] of Object.entries(extra?.stubs ?? {})) {
    const dest = path.join(stubDir, name);
    fs.writeFileSync(dest, body);
    fs.chmodSync(dest, 0o755);
  }
  const result = spawnSync('bash', [INSTALL_SH, ...args], {
    encoding: 'utf8',
    env: {
      HOME: env.HOME ?? tmp,
      TMPDIR: os.tmpdir(),
      LANG: 'C',
      ...env,
      PATH: `${stubDir}${path.delimiter}${env.PATH ?? process.env.PATH ?? '/usr/bin:/bin'}`,
    },
  });
  return { ...result, tmp, stubDir };
}

function unameStub(sysname: string, machine: string): string {
  return `#!/bin/sh
case "$1" in
  -s) echo '${sysname}' ;;
  -m) echo '${machine}' ;;
  *) echo '${sysname}' ;;
esac
`;
}

function curlStub(logFile: string): string {
  return `#!/bin/sh
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) out="$2"; shift 2 ;;
    --retry|--retry-delay) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >> '${logFile}'
if [ -z "$out" ]; then
  echo "missing -o" >&2
  exit 1
fi
printf '%s\\n' '#!/bin/sh' 'exit 0' > "$out"
chmod +x "$out"
`;
}

test('install.sh is valid bash', () => {
  const result = spawnSync('bash', ['-n', INSTALL_SH], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('README documents the curl installer served from main', () => {
  const readme = fs.readFileSync(README, 'utf8');
  assert.match(
    readme,
    /curl -fsSL https:\/\/raw\.githubusercontent\.com\/d0whc3r\/agent-warmup\/main\/install\.sh \| bash/,
  );
});

test('--print-target maps uname to the SEA asset suffix', () => {
  const cases = [
    ['Darwin', 'arm64', 'darwin-arm64'],
    ['Darwin', 'x86_64', 'darwin-x64'],
    ['Linux', 'x86_64', 'linux-x64'],
    ['Linux', 'aarch64', 'linux-arm64'],
    ['Linux', 'amd64', 'linux-x64'],
  ] as const;
  for (const [sysname, machine, expected] of cases) {
    const result = runInstall(
      ['--print-target'],
      {},
      { stubs: { uname: unameStub(sysname, machine) } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected, `${sysname} ${machine}`);
  }
});

test('--print-target rejects unsupported platforms', () => {
  const windows = runInstall(
    ['--print-target'],
    {},
    { stubs: { uname: unameStub('MINGW64_NT-10.0', 'x86_64') } },
  );
  assert.notEqual(windows.status, 0);
  assert.match(windows.stderr, /Windows is not supported/);

  const arch = runInstall(
    ['--print-target'],
    {},
    { stubs: { uname: unameStub('Linux', 'riscv64') } },
  );
  assert.notEqual(arch.status, 0);
  assert.match(arch.stderr, /unsupported arch: riscv64/);
});

test('--print-url uses latest GitHub Release by default', () => {
  const result = runInstall(
    ['--print-url'],
    {},
    { stubs: { uname: unameStub('Darwin', 'arm64') } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    'https://github.com/d0whc3r/agent-warmup/releases/latest/download/agent-warmup-darwin-arm64',
  );
});

test('--print-url pins VERSION and accepts a tag without the v prefix', () => {
  const tagged = runInstall(
    ['--print-url'],
    { VERSION: 'v1.2.3' },
    { stubs: { uname: unameStub('Linux', 'x86_64') } },
  );
  assert.equal(tagged.status, 0, tagged.stderr);
  assert.equal(
    tagged.stdout.trim(),
    'https://github.com/d0whc3r/agent-warmup/releases/download/v1.2.3/agent-warmup-linux-x64',
  );

  const bare = runInstall(
    ['--print-url'],
    { VERSION: '1.2.3' },
    { stubs: { uname: unameStub('Linux', 'x86_64') } },
  );
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stdout.trim(), tagged.stdout.trim());
});

test('--print-dir defaults to ~/.local/bin and honors INSTALL_DIR', () => {
  const home = runInstall(['--print-dir'], { HOME: '/tmp/warmup-home' });
  assert.equal(home.status, 0, home.stderr);
  assert.equal(home.stdout.trim(), '/tmp/warmup-home/.local/bin');

  const custom = runInstall(['--print-dir'], {
    HOME: '/tmp/warmup-home',
    INSTALL_DIR: '/opt/bin',
  });
  assert.equal(custom.status, 0, custom.stderr);
  assert.equal(custom.stdout.trim(), '/opt/bin');
});

test('installs the binary and claude-warmup alias into INSTALL_DIR', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-warmup-install-'));
  const destDir = path.join(tmp, 'bin');
  const logFile = path.join(tmp, 'curl.log');
  const result = runInstall(
    [],
    {
      HOME: tmp,
      INSTALL_DIR: destDir,
    },
    {
      stubs: {
        uname: unameStub('Linux', 'x86_64'),
        curl: curlStub(logFile),
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const binary = path.join(destDir, 'agent-warmup');
  const alias = path.join(destDir, 'claude-warmup');
  assert.equal(fs.existsSync(binary), true);
  assert.equal(Boolean(fs.statSync(binary).mode & 0o111), true);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(alias), binary);

  const urls = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  assert.equal(
    urls.at(-1),
    'https://github.com/d0whc3r/agent-warmup/releases/latest/download/agent-warmup-linux-x64',
  );
  assert.match(result.stdout, /PATH does not include/);
});
