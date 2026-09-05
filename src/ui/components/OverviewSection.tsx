// The overview tab: everything you would otherwise have to read three screens (or
// run `agent-warmup status`) to learn — is the scheduler live, when does it fire
// next, and where does every agent stand. Nothing here is editable; the tab's
// focusable rows are the actions, which live beside it.
import { Box, Text } from 'ink';

import { ago, pad2 } from '../../format.js';
import { minutesSince } from '../../time.js';
import type { Config, MultiConfig, ProviderCache, ProviderId, Status } from '../../types.js';
import { LABEL_W } from '../model.js';
import { Card, SettingRow } from './primitives.jsx';

const ID_W = 10;
// The status labels are one word each, so they get a tighter column than the setting
// rows elsewhere — it buys three columns for the values on narrow terminals.
const STATUS_LABEL_W = 10;

// One agent's cached limits, compressed to a single line. Percentages only — the
// reset clocks live on the agents tab, where there is room for them.
function usageLine(cache: ProviderCache | null | undefined): string {
  if (!cache || (!cache.session && !cache.week)) return 'no usage data yet';
  const parts: string[] = [];
  if (cache.session?.pct != null) {
    parts.push(`session ${cache.session.pct}%${cache.session.active ? '' : ' (idle)'}`);
  }
  if (cache.week?.pct != null) parts.push(`week ${cache.week.pct}%`);
  if (cache.lastDecision) parts.push(cache.lastDecision.action);
  return parts.length ? parts.join(' · ') : 'no usage data yet';
}

function schedulerValue(status: Status, view: Config): string {
  const state = status.active ? 'active' : 'inactive';
  if (view.scheduler === 'launchd') {
    return `launchd · ${state}${status.launchd.installed ? '' : ' · not installed'}`;
  }
  return `cron · ${state}${status.cron.installed ? '' : ' · not installed'}`;
}

// The band (smart) or the union of every enabled agent's hours (fixed) — the part of
// the schedule the "next run" line doesn't already say.
function windowValue(config: MultiConfig, ids: readonly ProviderId[], view: Config): string {
  if (view.mode === 'smart') {
    return `${pad2(view.smart.workStart)}–${pad2(view.smart.workEnd)}h · stop at ${view.smart.weeklyStopPercent}% weekly`;
  }
  const hours = [
    ...new Set(
      ids
        .filter((id) => config.providers[id]?.enabled)
        .flatMap((id) => config.providers[id]!.schedule),
    ),
  ].sort((a, b) => a - b);
  return hours.length ? hours.map((h) => `${pad2(h)}:00`).join(' ') : 'no hours selected';
}

// The last tick line, minus the log timestamp and the trailing source tag: what
// happened, not when it was written (the AGENTS block below carries the age).
function lastRunValue(lastRun: string): string {
  return lastRun
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/\s*\[via [^\]]*\]?$/, '')
    .trim();
}

export function OverviewSection({
  config,
  status,
  ids,
}: {
  config: MultiConfig;
  status: Status;
  ids: readonly ProviderId[];
}) {
  const view = status.view;
  const enabled = ids.filter((id) => config.providers[id]?.enabled).length;
  return (
    <>
      <Card title="STATUS">
        <SettingRow
          labelWidth={STATUS_LABEL_W}
          focused={false}
          label="Scheduler"
          ariaValue={schedulerValue(status, view)}
        >
          <Text>{schedulerValue(status, view)}</Text>
        </SettingRow>
        <SettingRow
          labelWidth={STATUS_LABEL_W}
          focused={false}
          label="Next run"
          ariaValue={status.nextRun ?? 'not scheduled'}
        >
          <Text>{status.nextRun ?? 'not scheduled'}</Text>
        </SettingRow>
        <SettingRow labelWidth={STATUS_LABEL_W} focused={false} label="Mode" ariaValue={view.mode}>
          <Text>{view.mode}</Text>
        </SettingRow>
        <SettingRow
          labelWidth={STATUS_LABEL_W}
          focused={false}
          label="Window"
          ariaValue={windowValue(config, ids, view)}
        >
          <Text>{windowValue(config, ids, view)}</Text>
        </SettingRow>
        <SettingRow
          labelWidth={STATUS_LABEL_W}
          focused={false}
          label="Agents"
          ariaValue={`${enabled} of ${ids.length} enabled`}
        >
          <Text>{`${enabled} of ${ids.length} enabled`}</Text>
        </SettingRow>
        {status.lastRun ? (
          <Box flexDirection="column" aria-label={`Last run: ${lastRunValue(status.lastRun)}`}>
            <Box aria-hidden>
              <Text>{'  '}</Text>
              <Text>Last run</Text>
            </Box>
            <Box aria-hidden paddingLeft={4}>
              <Text dimColor>{lastRunValue(status.lastRun)}</Text>
            </Box>
          </Box>
        ) : null}
      </Card>

      <Card title="AGENTS">
        {ids.map((id) => {
          const provider = config.providers[id];
          if (!provider) return null;
          const cache = status.usage?.providers?.[id] ?? null;
          const selected = config.shared.selectedProvider === id;
          const usage = usageLine(cache);
          const age = minutesSince(cache?.capturedAt);
          const state = `${provider.enabled ? 'enabled' : 'disabled'}${selected ? ', selected' : ''}`;
          return (
            <Box key={id} flexDirection="column">
              <Box aria-label={`${id}: ${state}, model ${provider.model}, ${usage}`}>
                <Box aria-hidden flexShrink={0}>
                  <Text bold={provider.enabled} color={provider.enabled ? 'green' : 'gray'}>
                    {provider.enabled ? '● ' : '○ '}
                  </Text>
                  <Text bold={selected}>{(selected ? `${id}*` : id).padEnd(ID_W)}</Text>
                </Box>
                <Text aria-hidden dimColor>
                  {provider.model}
                </Text>
              </Box>
              <Box aria-hidden paddingLeft={LABEL_W - 9}>
                <Text dimColor>{age != null ? `${usage} · ${ago(age)}` : usage}</Text>
              </Box>
            </Box>
          );
        })}
      </Card>
    </>
  );
}
