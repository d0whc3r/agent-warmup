// Subscription-backed coding agents whose CLIs do not expose a stable,
// machine-readable quota command. They share the conservative cache strategy:
// one successful arm counts as an active five-hour window; failures trip a
// short circuit breaker so a broken login cannot be hammered by the scheduler.
import fs from 'node:fs';

import { ARM_SCRIPT, ARM_SCRIPT_SRC } from '../paths.js';
import type { ProviderId } from '../types.js';
import { decideWindow, inferWindowFromCache, recordArmWithCooldown } from './common.js';
import type { Provider } from './types.js';

interface SubscriptionProviderOptions {
  id: Extract<ProviderId, 'codex' | 'zai' | 'kimi' | 'minimax'>;
  name: string;
  models: readonly string[];
  script: 'codex' | 'kimi' | 'opencode';
  binaryEnv: string;
}

function createSubscriptionProvider(options: SubscriptionProviderOptions): Provider {
  return {
    id: options.id,
    name: options.name,
    modelChoices: options.models,
    probeKind: 'estimated',
    probe: () => null,
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
