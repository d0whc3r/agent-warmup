#!/usr/bin/env node
// claude-warmup CLI. With no subcommand it opens the Ink TUI; otherwise it runs
// a headless action so it stays scriptable.
import { loadConfig, saveConfig, MODELS, SCHEDULERS, MODES, getView } from './config.js';
import * as schedule from './schedule.js';
import * as launchd from './launchd.js';
import { runNow, viewLogs } from './runner.js';
import { getStatus } from './status.js';
import { runTick, readCache, writeCache } from './tick.js';
import { formatUsage } from './providers/claude.js';
import { probe as claudeProbe } from './providers/claude.js';
import { probe as opencodeProbe } from './providers/opencode.js';
import { printStatus } from './print-status.js';
import { LABEL, PLIST_PATH, WARMUP_LOG, CONFIG_PATH, USAGE_CACHE } from './paths.js';
import type { Config, ProviderId, ProviderInput, UiAction } from './types.js';
import { ALL_PROVIDER_IDS } from './providers/index.js';

const argv = process.argv.slice(2);
const cmd: string | undefined = argv[0];
const rest = argv.slice(1);

function reapplyIfActive(): boolean {
  if (getStatus().active) {
    schedule.applySchedule(loadConfig());
    return true;
  }
  return false;
}

// Persist a single config field on the SELECTED provider, re-apply the scheduler
// if it's running, and print the "✓ ... (applied)" confirmation. Used by the
// subcommands that mutate a single field.
function saveField(patch: Partial<Config>, summary: string): void {
  const multi = loadConfig();
  const id = multi.shared.selectedProvider;
  const view = getView(multi);
  const updated: Config = { ...view, ...patch };
  // Decompose the legacy Config back into the new schema: shared.mode/scheduler
  // go to shared, the rest goes to the selected provider. Other providers are
  // left untouched.
  const next = saveConfig({
    shared: { ...multi.shared, mode: updated.mode, scheduler: updated.scheduler },
    providers: {
      ...multi.providers,
      [id]: {
        ...multi.providers[id],
        model: updated.model,
        tmuxSession: updated.tmuxSession,
        workStart: updated.smart.workStart,
        workEnd: updated.smart.workEnd,
        weeklyStopPercent: updated.smart.weeklyStopPercent,
        schedule: updated.schedule,
      },
    },
  });
  if (getStatus().active) schedule.applySchedule(next);
  console.log(`✓ ${summary}${getStatus().active ? ' (applied)' : ''}`);
}

function requireChoice<T extends string>(
  name: string,
  valid: readonly T[],
  value: string | undefined,
): T {
  if (value !== undefined && (valid as readonly string[]).includes(value)) return value as T;
  console.error(`${name} must be one of: ${valid.join(', ')}`);
  process.exit(1);
}

function help(): void {
  console.log(`claude-warmup — keep Claude Code + OpenCode usage windows warm on a schedule

Usage:
  claude-warmup                    Open the interactive TUI
  claude-warmup status             Show current status (per-provider)
  claude-warmup usage [--provider ID]  Probe the current quota and print limits
  claude-warmup tick [--dry-run] [--provider ID]  Run one decision (probe → decide → maybe arm)
  claude-warmup run [--provider ID]  Run a warmup right now (foreground)
  claude-warmup start              Install + load the active scheduler
  claude-warmup stop               Remove both schedulers
  claude-warmup restart            Reload the active scheduler
  claude-warmup enable             Enable the launchd agent
  claude-warmup disable            Disable the launchd agent (kept installed)
  claude-warmup mode NAME          Set mode (${MODES.join(' | ')})
  claude-warmup schedule H ...     Set fixed-mode hours on the selected provider
  claude-warmup model NAME         Set model on the selected provider
  claude-warmup scheduler NAME     Choose scheduler (${SCHEDULERS.join(' | ')})
  claude-warmup provider list      Show enabled providers and their on/off
  claude-warmup provider ID enable|disable  Toggle a provider
  claude-warmup provider ID model NAME  Set a provider's warmup model
  claude-warmup provider ID schedule H ...  Set a provider's fixed-mode hours
  claude-warmup logs [-f]          Show recent warmup logs (-f to follow)
  claude-warmup help               Show this help

Files:
  config   ${CONFIG_PATH}
  cache    ${USAGE_CACHE}
  logs     ${WARMUP_LOG}
  plist    ${PLIST_PATH}  (label ${LABEL})`);
}

async function launchTUI(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('(no TTY — showing status; run in a terminal for the interactive UI)\n');
    printStatus();
    return;
  }
  const [{ render }, React, { default: App }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./ui/App.jsx'),
  ]);
  for (;;) {
    let pending: UiAction | null = null;
    const app = render(
      React.default.createElement(App, {
        onAction: (a: UiAction) => {
          pending = a;
        },
      }),
    );
    await app.waitUntilExit();
    if (pending === 'run') process.exit(runNow());
    if (pending !== 'logs') return;
    viewLogs(false);
  }
}

function parseProviderFlag(rest: string[]): { id: ProviderId; rest: string[] } {
  const i = rest.indexOf('--provider');
  if (i === -1) return { id: loadConfig().shared.selectedProvider, rest };
  const id = rest[i + 1] as ProviderId;
  if (!id || !ALL_PROVIDER_IDS.includes(id)) {
    console.error(`--provider must be one of: ${ALL_PROVIDER_IDS.join(', ')}`);
    process.exit(1);
  }
  return { id, rest: rest.filter((_, idx) => idx !== i && idx !== i + 1) };
}

switch (cmd) {
  case undefined:
    await launchTUI();
    break;
  case 'status':
    printStatus();
    break;
  case 'usage': {
    const { id, rest: _r2 } = parseProviderFlag(rest);
    const multi = loadConfig();
    const provider = multi.providers[id];
    if (!provider) {
      console.error(`✗ no such provider: ${id}`);
      process.exit(1);
    }
    process.stderr.write(`probing ${id} (${provider.model})…\n`);
    const ctx = { cfg: provider, shared: multi.shared, now: new Date() };
    const usage = id === 'opencode' ? opencodeProbe(ctx) : claudeProbe(ctx);
    if (!usage) {
      console.error(`✗ could not read usage for ${id} (binary on PATH? tmux installed?)`);
      process.exit(1);
    }
    const cache = readCache();
    cache.providers = cache.providers ?? {};
    cache.providers[id] = {
      ...cache.providers[id],
      capturedAt: usage.capturedAt,
      session: usage.session,
      week: usage.week,
      weekSonnet: usage.weekSonnet,
    };
    writeCache(cache);
    const u = formatUsage(cache.providers[id] ?? null);
    if (u) {
      console.log(`session  ${u.session}`);
      console.log(`weekly   ${u.week}`);
    }
    if (usage.weekSonnet && Number.isFinite(usage.weekSonnet.pct))
      console.log(`sonnet   ${usage.weekSonnet.pct}%`);
    break;
  }
  case 'tick': {
    const dryRun = rest.includes('--dry-run') || rest.includes('-n');
    const { id, rest: _r2 } = parseProviderFlag(rest);
    const { results } = runTick({ dryRun, providerId: id });
    for (const r of results) console.log(`[${r.id}] ${r.decision.action} — ${r.decision.reason}`);
    const warmed = results.find((r) => r.decision.action === 'warm' && !dryRun);
    process.exit(warmed ? warmed.status : 0);
  }
  case 'run':
  case 'now': {
    const { id, rest: _r2 } = parseProviderFlag(rest);
    process.exit(runNow(id));
  }
  case 'start': {
    const ok = schedule.applySchedule(loadConfig());
    console.log(ok ? '✓ scheduler installed and loaded' : '✗ failed to load scheduler');
    printStatus();
    break;
  }
  case 'stop':
    schedule.stopSchedule();
    console.log('✓ schedulers removed');
    break;
  case 'restart':
    schedule.stopSchedule();
    schedule.applySchedule(loadConfig());
    console.log('✓ scheduler reloaded');
    break;
  case 'enable':
    console.log(launchd.enable() ? '✓ enabled' : '✗ failed');
    break;
  case 'disable':
    console.log(launchd.disable() ? '✓ disabled' : '✗ failed');
    break;
  case 'mode': {
    const mode = requireChoice('mode', MODES, rest[0]);
    saveField({ mode }, `mode set: ${mode}`);
    break;
  }
  case 'schedule': {
    const hours = rest.map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
    if (!hours.length) {
      console.error('Provide hours 0-23, e.g. "schedule 8 13 18"');
      process.exit(1);
    }
    const multi = loadConfig();
    const id = multi.shared.selectedProvider;
    const c = saveConfig({
      ...multi,
      providers: { ...multi.providers, [id]: { ...multi.providers[id], schedule: hours } },
    });
    const out = c.providers[id]?.schedule ?? hours;
    console.log(`✓ schedule set: ${out.join(' ')}${reapplyIfActive() ? ' (applied)' : ''}`);
    break;
  }
  case 'model': {
    const model = requireChoice('model', MODELS, rest[0]);
    saveField({ model }, `model set: ${model}`);
    break;
  }
  case 'scheduler': {
    const scheduler = requireChoice('scheduler', SCHEDULERS, rest[0]);
    const wasActive = getStatus().active;
    const multi = loadConfig();
    const next = saveConfig({ ...multi, shared: { ...multi.shared, scheduler } });
    if (wasActive) schedule.applySchedule(next);
    console.log(`✓ scheduler set: ${next.shared.scheduler}${wasActive ? ' (applied)' : ''}`);
    break;
  }
  case 'provider': {
    handleProvider(rest);
    break;
  }
  case 'logs':
    viewLogs(rest.includes('-f') || rest.includes('--follow'));
    break;
  case 'help':
  case '-h':
  case '--help':
    help();
    break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    help();
    process.exit(1);
}

function handleProvider(rest: string[]): void {
  const [sub, id, action, ...args] = rest;
  if (sub === 'list' || !sub) {
    const multi = loadConfig();
    for (const pid of ALL_PROVIDER_IDS) {
      const p = multi.providers[pid];
      if (!p) continue;
      const mark = p.enabled ? '\x1b[32m●\x1b[0m' : '\x1b[31m○\x1b[0m';
      const sel = pid === multi.shared.selectedProvider ? ' (selected)' : '';
      console.log(`${mark} ${pid.padEnd(9)} enabled=${p.enabled}  model=${p.model}${sel}`);
    }
    return;
  }
  if (!id || !ALL_PROVIDER_IDS.includes(id as ProviderId)) {
    console.error(`provider id must be one of: ${ALL_PROVIDER_IDS.join(', ')}`);
    process.exit(1);
  }
  const pid = id as ProviderId;
  const multi = loadConfig();
  const provider = multi.providers[pid];
  if (!provider) {
    console.error(`✗ no such provider: ${pid}`);
    process.exit(1);
  }
  switch (action) {
    case 'enable':
    case 'disable': {
      const enabled = action === 'enable';
      const providers = multi.shared.providers.includes(pid)
        ? multi.shared.providers
        : [...multi.shared.providers, pid];
      const next = saveConfig({
        shared: {
          ...multi.shared,
          providers: enabled ? providers : multi.shared.providers.filter((x) => x !== pid),
        },
        providers: { ...multi.providers, [pid]: { ...provider, enabled } },
      });
      console.log(
        `✓ ${pid} ${enabled ? 'enabled' : 'disabled'}${reapplyIfActive() ? ' (applied)' : ''}`,
      );
      void next;
      break;
    }
    case 'model': {
      const model = args[0];
      if (!model) {
        console.error('Usage: claude-warmup provider <id> model <name>');
        process.exit(1);
      }
      const patch: ProviderInput = { model };
      const next = saveConfig({
        ...multi,
        providers: { ...multi.providers, [pid]: { ...provider, ...patch } },
      });
      console.log(`✓ ${pid} model → ${model}${reapplyIfActive() ? ' (applied)' : ''}`);
      void next;
      break;
    }
    case 'schedule': {
      const hours = args.map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
      if (!hours.length) {
        console.error('Provide hours 0-23, e.g. "provider opencode schedule 9 14 19"');
        process.exit(1);
      }
      const patch: ProviderInput = { schedule: hours };
      const next = saveConfig({
        ...multi,
        providers: { ...multi.providers, [pid]: { ...provider, ...patch } },
      });
      console.log(`✓ ${pid} schedule → ${hours.join(' ')}${reapplyIfActive() ? ' (applied)' : ''}`);
      void next;
      break;
    }
    default:
      console.error(`Unknown provider subcommand: ${action}`);
      console.error(
        'Usage: claude-warmup provider [list | <id> enable|disable|model <name>|schedule H ...]',
      );
      process.exit(1);
  }
}
