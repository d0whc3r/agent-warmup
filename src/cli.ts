#!/usr/bin/env node
// agent-warmup CLI. With no subcommand it opens the Ink TUI; otherwise it runs
// a headless action so it stays scriptable.
import { loadConfig, saveConfig, MODELS, SCHEDULERS, MODES, getView } from './config.js';
import { detectAll, detectProvider } from './detect.js';
import * as launchd from './launchd.js';
import {
  LABEL,
  LEGACY_HOME,
  PLIST_PATH,
  WARMUP_HOME,
  WARMUP_LOG,
  CONFIG_PATH,
  USAGE_CACHE,
  migrateLegacyHome,
} from './paths.js';
import { printStatus } from './print-status.js';
import { formatUsage } from './providers/claude.js';
import { ALL_PROVIDER_IDS, getProvider } from './providers/index.js';
import { runEnabled, runNow, viewLogs } from './runner.js';
import * as schedule from './schedule.js';
import { getStatus } from './status.js';
import { runTick, readCache, writeCache } from './tick.js';
import type { Config, ProviderConfig, ProviderId, ProviderInput, UiAction } from './types.js';

const argv = process.argv.slice(2);
const cmd: string | undefined = argv[0];
const rest = argv.slice(1);

// Pre-rename installs lived under ~/.claude/warmup; move them into the neutral home
// before anything reads config, cache or logs.
if (migrateLegacyHome()) console.error(`✓ moved ${LEGACY_HOME} → ${WARMUP_HOME}`);

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
  console.log(`agent-warmup — align coding-agent quota windows with your working hours

Usage:
  agent-warmup                    Open the interactive TUI
  agent-warmup status             Show current status (per-provider)
  agent-warmup usage [--provider ID]  Probe or estimate current limits
  agent-warmup tick [--dry-run] [--provider ID]  Decide and maybe warm
  agent-warmup run [--provider ID]  Warm every enabled agent now (or just one)
  agent-warmup start|stop|restart Manage the active scheduler
  agent-warmup enable|disable      Toggle the installed launchd agent
  agent-warmup mode NAME          Set mode (${MODES.join(' | ')})
  agent-warmup schedule H ...     Set fixed-mode hours on the selected provider
  agent-warmup model NAME         Set model on the selected provider
  agent-warmup scheduler NAME     Choose scheduler (${SCHEDULERS.join(' | ')})
  agent-warmup detect [--apply]   Find installed agent CLIs (--apply saves paths)
  agent-warmup provider list      Show all built-in providers
  agent-warmup provider ID detect Detect and save this provider's binary path
  agent-warmup provider ID enable|disable|select
  agent-warmup provider ID model NAME
  agent-warmup provider ID binary PATH
  agent-warmup provider ID schedule H ...
  agent-warmup logs [-f]          Show recent warmup logs (-f to follow)
  agent-warmup help               Show this help

The legacy command name \`claude-warmup\` remains an alias.

Files:
  config   ${CONFIG_PATH}
  cache    ${USAGE_CACHE}
  logs     ${WARMUP_LOG}
  plist    ${PLIST_PATH}  (label ${LABEL})`);
}

async function launchTUI(): Promise<void> {
  schedule.repairStaleEntry();
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
    if (pending === 'run') process.exit(await runEnabled());
    if (pending !== 'logs') return;
    viewLogs(false);
  }
}

function parseProviderFlag(
  rest: string[],
  defaultToSelected = true,
): { id: ProviderId | undefined; rest: string[] } {
  const i = rest.indexOf('--provider');
  if (i === -1) {
    return {
      id: defaultToSelected ? loadConfig().shared.selectedProvider : undefined,
      rest,
    };
  }
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
    schedule.repairStaleEntry();
    printStatus();
    break;
  case 'usage': {
    const { id, rest: _r2 } = parseProviderFlag(rest);
    if (!id) throw new Error('selected provider is unavailable');
    const multi = loadConfig();
    const provider = multi.providers[id];
    if (!provider) {
      console.error(`✗ no such provider: ${id}`);
      process.exit(1);
    }
    process.stderr.write(`probing ${id} (${provider.model})…\n`);
    const ctx = { cfg: provider, shared: multi.shared, now: new Date() };
    const adapter = getProvider(id);
    const live = await adapter.probe(ctx);
    const cache = readCache();
    cache.providers = cache.providers ?? {};
    const usage = live ?? adapter.inferFromCache(ctx, cache.providers[id] ?? null);
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
    if (!live) console.log(`source   estimated from local warmup history (${adapter.name})`);
    break;
  }
  case 'tick': {
    const dryRun = rest.includes('--dry-run') || rest.includes('-n');
    // An unqualified scheduler tick must visit every enabled provider. The
    // selected provider is only a UI/default-run concern.
    const { id, rest: _r2 } = parseProviderFlag(rest, false);
    const { results } = await runTick({ dryRun, providerId: id });
    for (const r of results) console.log(`[${r.id}] ${r.decision.action} — ${r.decision.reason}`);
    // Surface the worst arm status so launchd/cron monitoring sees failures
    // from any provider, not just the first one in the iteration order.
    const failed = results.find((r) => r.status !== 0);
    process.exit(failed ? failed.status : 0);
  }
  case 'run':
  case 'now': {
    // No --provider means every enabled agent, matching the TUI's "Run warmup"
    // action and the set the scheduler's tick would arm.
    const { id, rest: _r2 } = parseProviderFlag(rest, false);
    process.exit(id ? await runNow(id) : await runEnabled());
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
    const model = rest[0];
    if (!model) {
      console.error('Usage: agent-warmup model <name>');
      process.exit(1);
    }
    const selId = loadConfig().shared.selectedProvider;
    if (selId === 'claude' && !(MODELS as readonly string[]).includes(model)) {
      console.error(
        `model must be one of: ${MODELS.join(', ')} (other providers accept their own model ids)`,
      );
      process.exit(1);
    }
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
  case 'detect': {
    handleDetect(rest.includes('--apply'));
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

// Scan for installed agent CLIs. Read-only by default; `--apply` writes the
// detected absolute path for every provider whose configured path does not work,
// which is what makes an agent usable from launchd/cron without hand-editing.
function handleDetect(apply: boolean): void {
  const multi = loadConfig();
  const found = detectAll(multi);
  const patched: Partial<Record<ProviderId, ProviderConfig>> = {};
  for (const d of found) {
    const mark = d.path ? '\x1b[32m●\x1b[0m' : '\x1b[31m○\x1b[0m';
    const where = d.path ?? `not found (looked for "${d.binary}")`;
    const stale = d.path && !d.configuredOk ? `  (config points at ${d.configured})` : '';
    console.log(`${mark} ${d.id.padEnd(9)} ${where}${stale}`);
    const provider = multi.providers[d.id];
    if (apply && provider && d.path && !d.configuredOk)
      patched[d.id] = { ...provider, binary: d.path };
  }
  if (!apply) {
    console.log('\nRun `agent-warmup detect --apply` to save the detected paths.');
    return;
  }
  const ids = Object.keys(patched) as ProviderId[];
  if (!ids.length) {
    console.log('\n✓ nothing to change — every configured binary path is valid');
    return;
  }
  saveConfig({ ...multi, providers: { ...multi.providers, ...patched } });
  console.log(`\n✓ saved paths for: ${ids.join(', ')}${reapplyIfActive() ? ' (applied)' : ''}`);
}

function handleProvider(rest: string[]): void {
  const [id, action, ...args] = rest;
  if (id === 'list' || !id) {
    const multi = loadConfig();
    for (const pid of ALL_PROVIDER_IDS) {
      const p = multi.providers[pid];
      if (!p) continue;
      const mark = p.enabled ? '\x1b[32m●\x1b[0m' : '\x1b[31m○\x1b[0m';
      const sel = pid === multi.shared.selectedProvider ? ' (selected)' : '';
      const adapter = getProvider(pid);
      const found = detectProvider(pid, p.binary).path;
      console.log(
        `${mark} ${pid.padEnd(9)} ${adapter.name.padEnd(23)} enabled=${p.enabled}  usage=${adapter.probeKind}  model=${p.model}  bin=${found ?? 'not found'}${sel}`,
      );
    }
    return;
  }
  if (!ALL_PROVIDER_IDS.includes(id as ProviderId)) {
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
    case 'select': {
      if (!provider.enabled) {
        console.error(`✗ provider ${pid} is disabled; enable it before selecting it`);
        process.exit(1);
      }
      saveConfig({ ...multi, shared: { ...multi.shared, selectedProvider: pid } });
      console.log(`✓ selected provider → ${pid}`);
      break;
    }
    case 'model': {
      const model = args[0];
      if (!model) {
        console.error('Usage: agent-warmup provider <id> model <name>');
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
    case 'detect': {
      const found = detectProvider(pid, provider.binary);
      if (!found.path) {
        console.error(`✗ ${pid}: no "${found.binary}" executable found on this machine`);
        process.exit(1);
      }
      saveConfig({
        ...multi,
        providers: { ...multi.providers, [pid]: { ...provider, binary: found.path } },
      });
      console.log(`✓ ${pid} binary → ${found.path}${reapplyIfActive() ? ' (applied)' : ''}`);
      break;
    }
    case 'binary': {
      const binary = args[0];
      if (!binary) {
        console.error('Usage: agent-warmup provider <id> binary <path>');
        process.exit(1);
      }
      saveConfig({
        ...multi,
        providers: { ...multi.providers, [pid]: { ...provider, binary } },
      });
      console.log(`✓ ${pid} binary → ${binary}${reapplyIfActive() ? ' (applied)' : ''}`);
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
        'Usage: agent-warmup provider [list | <id> enable|disable|select|detect|model <name>|binary <path>|schedule H ...]',
      );
      process.exit(1);
  }
}
