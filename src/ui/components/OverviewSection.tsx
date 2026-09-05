// The overview tab: everything you would otherwise have to read three screens (or
// run `agent-warmup status`) to learn — is the scheduler live, when does it fire
// next, and where does every agent stand. Nothing here is editable; the actions are
// the global keys in the status-bar legend.
import { Box, Text } from 'ink';

import { ago, pad2 } from '../../format.js';
import { minutesSince } from '../../time.js';
import type { Config, MultiConfig, ProviderCache, ProviderId, Status } from '../../types.js';
import { Card, SettingRow, Split } from './primitives.jsx';

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

// The mode plus the window it defines: the band (smart) or the union of every
// enabled agent's hours (fixed) — the part of the schedule "next run" doesn't say.
function windowValue(config: MultiConfig, ids: readonly ProviderId[], view: Config): string {
  if (view.mode === 'smart') {
    return `smart · ${pad2(view.smart.workStart)}–${pad2(view.smart.workEnd)}h · weekly stop ${view.smart.weeklyStopPercent}%`;
  }
  const hours = [
    ...new Set(
      ids
        .filter((id) => config.providers[id]?.enabled)
        .flatMap((id) => config.providers[id]!.schedule),
    ),
  ].sort((a, b) => a - b);
  return `fixed · ${hours.length ? hours.map((h) => `${pad2(h)}:00`).join(' ') : 'no hours selected'}`;
}

// The last tick line, minus the log timestamp and the trailing source tag: what
// happened, not when it was written (the AGENTS card below carries the age).
function lastRunValue(lastRun: string): string {
  return lastRun
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/\s*\[via [^\]]*\]?$/, '')
    .trim();
}

function StatusCard({
  config,
  status,
  ids,
}: {
  config: MultiConfig;
  status: Status;
  ids: readonly ProviderId[];
}) {
  const view = status.view;
  const rows: [string, string][] = [
    ['Scheduler', schedulerValue(status, view)],
    ['Next run', status.nextRun ?? 'not scheduled'],
    ['Window', windowValue(config, ids, view)],
  ];
  if (status.lastRun) rows.push(['Last run', lastRunValue(status.lastRun)]);
  return (
    <Card title="STATUS">
      {rows.map(([label, value]) => (
        <SettingRow
          key={label}
          labelWidth={STATUS_LABEL_W}
          focused={false}
          label={label}
          ariaValue={value}
        >
          <Text>{value}</Text>
        </SettingRow>
      ))}
    </Card>
  );
}

// One agent per entry: enabled agents get their model and a usage line, disabled
// ones collapse to a single dimmed row so the list stays short with six agents.
function AgentsCard({
  config,
  status,
  ids,
}: {
  config: MultiConfig;
  status: Status;
  ids: readonly ProviderId[];
}) {
  return (
    <Card title="AGENTS" hint="* = default">
      {ids.map((id) => {
        const provider = config.providers[id];
        if (!provider) return null;
        const selected = config.shared.selectedProvider === id;
        const name = (selected ? `${id}*` : id).padEnd(ID_W);
        const state = `${provider.enabled ? 'enabled' : 'disabled'}${selected ? ', selected' : ''}`;
        if (!provider.enabled) {
          return (
            <Box key={id} aria-label={`${id}: ${state}`}>
              <Text aria-hidden dimColor>{`○ ${name}disabled`}</Text>
            </Box>
          );
        }
        const cache = status.usage?.providers?.[id] ?? null;
        const usage = usageLine(cache);
        const age = minutesSince(cache?.capturedAt);
        return (
          <Box
            key={id}
            flexDirection="column"
            aria-label={`${id}: ${state}, model ${provider.model}, ${usage}`}
          >
            <Box aria-hidden>
              <Text bold color="green">
                {'● '}
              </Text>
              <Text bold={selected}>{name}</Text>
              <Text dimColor>{provider.model}</Text>
            </Box>
            <Box aria-hidden paddingLeft={2}>
              <Text dimColor>{age != null ? `${usage} · ${ago(age)}` : usage}</Text>
            </Box>
          </Box>
        );
      })}
    </Card>
  );
}

export function OverviewSection({
  config,
  status,
  ids,
  wide,
}: {
  config: MultiConfig;
  status: Status;
  ids: readonly ProviderId[];
  wide: boolean;
}) {
  return (
    <Split
      wide={wide}
      left={<StatusCard config={config} status={status} ids={ids} />}
      right={<AgentsCard config={config} status={status} ids={ids} />}
    />
  );
}
