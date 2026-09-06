// Self-update: ask GitHub for the newest release, then hand the actual work to the
// same install.sh a fresh install uses — pointed at the directory this binary runs
// from, so it replaces itself in place instead of installing a second copy.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { isSea } from 'node:sea';

import { VERSION } from './version.js';

const REPO = 'd0whc3r/agent-warmup';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const INSTALL_SCRIPT = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;

// Tag of the newest published release, e.g. "v1.2.3".
export async function latestTag(): Promise<string> {
  const res = await fetch(LATEST_RELEASE_API, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`);
  const release = (await res.json()) as { tag_name?: string };
  if (!release.tag_name) throw new Error('the latest release has no tag');
  return release.tag_name;
}

export async function upgrade(): Promise<number> {
  // Only a single-executable install can be swapped by the installer; a source or
  // npm run has its own update path.
  if (!isSea()) {
    console.error('✗ upgrade replaces a binary installed from a GitHub Release');
    console.error(`  this run is not one — install with: curl -fsSL ${INSTALL_SCRIPT} | bash`);
    return 1;
  }

  let tag: string;
  try {
    tag = await latestTag();
  } catch (err) {
    console.error(`✗ could not read the latest release: ${(err as Error).message}`);
    return 1;
  }

  if (tag.replace(/^v/, '') === VERSION) {
    console.log(`✓ already on the latest release (${tag})`);
    return 0;
  }

  const dir = path.dirname(process.execPath);
  console.log(`› upgrading ${VERSION} → ${tag} in ${dir}`);
  // Unlinking a running executable is fine on macOS/Linux: the kernel keeps the
  // inode alive until this process exits, so the installer can swap it underneath us.
  const run = spawnSync('bash', ['-c', `curl -fsSL "${INSTALL_SCRIPT}" | bash`], {
    stdio: 'inherit',
    env: { ...process.env, INSTALL_DIR: dir, VERSION: tag },
  });
  return run.status ?? 1;
}
