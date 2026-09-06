// Locate the CLI binary of each supported agent. The scheduler runs from launchd
// or cron with a minimal PATH, so what has to end up in the config is an absolute
// path; detection is therefore a filesystem scan of the usual install prefixes
// plus the interactive PATH, not a `which` call at arm time.
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_MULTI } from './config.js';
import { expandHome, opencodeAuthPath } from './paths.js';
import { ALL_PROVIDER_IDS, getProvider } from './providers/index.js';
import type { MultiConfig, ProviderId } from './types.js';

// Prefixes coding-agent installers commonly use, searched after the provider's own
// default location and the current PATH.
const EXTRA_DIRS = [
  '~/.local/bin',
  '~/.bun/bin',
  '~/.volta/bin',
  '~/.npm-global/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
];

// Install locations that don't follow from the provider's default binary path.
const EXTRA_DIRS_BY_ID: Partial<Record<ProviderId, string[]>> = {
  claude: ['~/.claude/local'],
};

export interface Detection {
  id: ProviderId;
  name: string; // display name of the agent
  binary: string; // the executable name looked for (e.g. "opencode")
  path: string | null; // first executable found, absolute
  configured: string; // the path currently in the config (as written)
  configuredOk: boolean; // whether that path is executable right now
  // Why `path` is null even though the binary is on disk (an opencode-backed plan
  // with no credential). Null when the binary itself is simply missing.
  blocked: string | null;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Whether opencode holds a credential for this plan. Anything unreadable (no file,
// bad JSON) counts as "not configured" — the plan cannot arm either way.
function hasOpencodeCredential(key: string): boolean {
  try {
    const auth = JSON.parse(fs.readFileSync(opencodeAuthPath(), 'utf8')) as Record<string, unknown>;
    return Object.hasOwn(auth, key);
  } catch {
    return false;
  }
}

// Find the agent's binary. The configured path wins when it still works, so a
// hand-picked location is never silently replaced by one found on PATH.
export function detectProvider(id: ProviderId, configured?: string): Detection {
  const provider = getProvider(id);
  const fallback = DEFAULT_MULTI.providers[id]!.binary;
  const raw = configured || fallback;
  const configuredPath = expandHome(raw);
  const binary = path.basename(fallback);

  // The opencode-backed plans share one binary with opencode itself, so finding it
  // proves nothing: without the plan's credential the arm reaches opencode and comes
  // back a server error. Report those as not installed, with the reason.
  if (provider.credentialKey && !hasOpencodeCredential(provider.credentialKey)) {
    return {
      id,
      name: provider.name,
      binary,
      path: null,
      configured: raw,
      configuredOk: false,
      blocked: `no "${provider.credentialKey}" credential in opencode`,
    };
  }

  const dirs = [
    path.dirname(expandHome(fallback)),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    ...(EXTRA_DIRS_BY_ID[id] ?? []).map(expandHome),
    ...EXTRA_DIRS.map(expandHome),
  ];
  const configuredOk = isExecutable(configuredPath);
  let found: string | null = configuredOk ? configuredPath : null;
  if (!found) {
    for (const dir of dirs) {
      const candidate = path.join(dir, binary);
      if (isExecutable(candidate)) {
        found = candidate;
        break;
      }
    }
  }
  return {
    id,
    name: provider.name,
    binary,
    path: found,
    configured: raw,
    configuredOk,
    blocked: null,
  };
}

export function detectAll(multi?: MultiConfig): Detection[] {
  return ALL_PROVIDER_IDS.map((id) => detectProvider(id, multi?.providers[id]?.binary));
}
