// Per-provider arm scripts. In a single-executable (SEA) build the script text
// is held in memory (the provider's `armScript()` method) and materialized on
// demand under WARMUP_HOME so the scheduler can spawn it like an ordinary file.
// In dev/npm installs the script lives at src/assets/arm-<id>.sh (no extraction
// needed); assets.ts is the central place that decides which path to use.
import fs from 'node:fs';
import path from 'node:path';
import { isSea, getAsset } from 'node:sea';
import { ARM_SCRIPT } from './paths.js';
import { getProvider } from './providers/index.js';
import type { ProviderId } from './types.js';

// Materialize a provider's arm script under WARMUP_HOME (SEA build) or return
// the source path (dev/npm). Idempotent; safe to call from every arm site.
export function ensureArmScript(id: ProviderId): string {
  const dest = ARM_SCRIPT(id);
  if (!isSea() && fs.existsSync(dest)) {
    fs.chmodSync(dest, 0o755);
    return dest;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Prefer the embedded asset (so a single executable ships everything);
  // fall back to the provider's armScript() string if the asset isn't
  // registered (defensive: the asset is only injected at SEA build time).
  let content: string;
  try {
    if (!isSea()) throw new Error('source asset is shared by another provider');
    content = getAsset(`arm-${id}.sh`, 'utf8') as string;
  } catch {
    content = getProvider(id).armScript();
  }
  fs.writeFileSync(dest, content);
  fs.chmodSync(dest, 0o755);
  return dest;
}
