// Subscription-backed coding agents whose CLIs do not expose a stable,
// machine-readable quota command. They share the conservative cache strategy:
// one successful arm counts as an active five-hour window; failures trip a
// short circuit breaker so a broken login cannot be hammered by the scheduler.
import fs from 'node:fs';
import path from 'node:path';

import { ARM_SCRIPT, ARM_SCRIPT_SRC, HOME } from '../paths.js';
import { isAfter } from '../time.js';
import type { LimitBlock, ProviderId, ProviderUsage } from '../types.js';
import { decideWindow, inferWindowFromCache, recordArmWithCooldown } from './common.js';
import type { ProbeContext, Provider } from './types.js';

interface SubscriptionProviderOptions {
  id: Extract<ProviderId, 'codex' | 'zai' | 'kimi' | 'minimax'>;
  name: string;
  models: readonly string[];
  script: 'codex' | 'kimi' | 'opencode';
  binaryEnv: string;
  probe?: Provider['probe'];
}

// Codex has no quota command, but every interactive session logs its server-side
// rate limits (`token_count` events) into ~/.codex/sessions/**/*.jsonl. Parse the
// newest such event: `primary` is the five-hour window, `secondary` the weekly one.
interface CodexRateLimits {
  primary?: { used_percent?: number; resets_at?: number } | null;
  secondary?: { used_percent?: number; resets_at?: number } | null;
}

export function parseCodexRateLimits(text: string, now: Date): ProviderUsage | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"rate_limits"')) continue;
    let obj: { timestamp?: string; payload?: { rate_limits?: CodexRateLimits } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const limits = obj.payload?.rate_limits;
    if (!limits?.primary && !limits?.secondary) continue;
    const block = (w: CodexRateLimits['primary']): LimitBlock | null =>
      w
        ? {
            pct: typeof w.used_percent === 'number' ? Math.round(w.used_percent) : null,
            resetsAt: w.resets_at ? new Date(w.resets_at * 1000) : null,
          }
        : null;
    const session = block(limits.primary);
    if (session) {
      session.active =
        (session.pct ?? 0) > 0 && !!session.resetsAt && isAfter(session.resetsAt, now);
    }
    const stamp = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    return {
      session,
      week: block(limits.secondary),
      capturedAt: Number.isFinite(stamp) ? stamp : now.getTime(),
    };
  }
  return null;
}

// Newest session log under CODEX_HOME/sessions (rollout files are appended while
// a session runs, so mtime, not the filename date, picks the freshest limits).
function probeCodex(ctx: ProbeContext): ProviderUsage | null {
  const dir = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'sessions');
  let newest: { file: string; mtime: number } | null = null;
  try {
    for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) {
      if (!rel.endsWith('.jsonl')) continue;
      const file = path.join(dir, rel);
      const mtime = fs.statSync(file).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    }
    return newest ? parseCodexRateLimits(fs.readFileSync(newest.file, 'utf8'), ctx.now) : null;
  } catch {
    return null;
  }
}

function createSubscriptionProvider(options: SubscriptionProviderOptions): Provider {
  return {
    id: options.id,
    name: options.name,
    modelChoices: options.models,
    probeKind: options.probe ? 'live' : 'estimated',
    probe: options.probe ?? (() => null),
    inferFromCache: inferWindowFromCache,
    decide: decideWindow,
    armScript: () => fs.readFileSync(ARM_SCRIPT_SRC(options.script), 'utf8'),
    armScriptPath: () => ARM_SCRIPT(options.id),
    armEnv: (ctx) => ({
      [options.binaryEnv]: ctx.cfg.binary,
      WARMUP_PROVIDER: options.id,
      WARMUP_PROVIDER_NAME: options.name,
    }),
    recordArmResult: (ctx, cache, status) => recordArmWithCooldown(cache, status, ctx.now),
  };
}

export const codexProvider = createSubscriptionProvider({
  id: 'codex',
  name: 'OpenAI Codex',
  models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
  script: 'codex',
  binaryEnv: 'CODEX_BIN',
  probe: probeCodex,
});

export const zaiProvider = createSubscriptionProvider({
  id: 'zai',
  name: 'Z.AI GLM Coding Plan',
  models: [
    'zai-coding-plan/glm-5.3-flash',
    'zai-coding-plan/glm-5.3',
    'zai-coding-plan/glm-5.3-highspeed',
  ],
  script: 'opencode',
  binaryEnv: 'OPENCODE_BIN',
});

export const kimiProvider = createSubscriptionProvider({
  id: 'kimi',
  name: 'Kimi Code',
  models: ['kimi-code/kimi-for-coding', 'kimi-code/kimi-for-coding-highspeed'],
  script: 'kimi',
  binaryEnv: 'KIMI_BIN',
});

export const minimaxProvider = createSubscriptionProvider({
  id: 'minimax',
  name: 'MiniMax Token Plan',
  models: [
    'minimax-coding-plan/MiniMax-M2.7',
    'minimax-coding-plan/MiniMax-M2.7-highspeed',
    'minimax-coding-plan/MiniMax-M3',
  ],
  script: 'opencode',
  binaryEnv: 'OPENCODE_BIN',
});
