// The schedule tab is two cards. SCHEDULE holds what every agent shares (mode,
// scheduler, tick); HOURS · <agent> holds the default agent's own window, because
// work hours and the fixed-mode grid are per agent — naming the agent in the title
// is what tells you whose hours you are editing (p switches it). Both modes expose
// a TEXT summary that is the accessible source of truth; the glyph art — the
// smart-mode band bar and the fixed-mode hour grid — is aria-hidden, so the screen
// reader hears the summary instead of a wall of block characters.
import { Box, Text } from 'ink';

import { pad2 } from '../../format.js';
import type { Config, ProviderId, SmartConfig } from '../../types.js';
import { AXIS, chunk, HOURS } from '../model.js';
import { Card, Choice, Pointer, SettingRow, Split } from './primitives.jsx';

const SHARED_KEYS = ['mode', 'scheduler', 'tick'];
const HOURS_KEYS = ['workStart', 'workEnd', 'weeklyStop', 'schedule'];

function SharedCard({ config, focusedKey }: { config: Config; focusedKey: string }) {
  return (
    <Card title="SCHEDULE" active={SHARED_KEYS.includes(focusedKey)}>
      <SettingRow focused={focusedKey === 'mode'} label="Mode" ariaValue={config.mode}>
        <Choice value={config.mode} focused={focusedKey === 'mode'} />
      </SettingRow>
      <SettingRow
        focused={focusedKey === 'scheduler'}
        label="Scheduler"
        ariaValue={config.scheduler}
      >
        <Choice value={config.scheduler} focused={focusedKey === 'scheduler'} />
      </SettingRow>
      {config.mode === 'smart' ? (
        <SettingRow
          focused={focusedKey === 'tick'}
          label="Tick"
          ariaValue={`${config.smart.tickMinutes} min`}
        >
          <Choice value={`${config.smart.tickMinutes}m`} focused={focusedKey === 'tick'} />
        </SettingRow>
      ) : null}
    </Card>
  );
}

// Smart mode: a lit work band ("█") over the rest of the day ("·"). Lit vs unlit is a
// shape difference (block vs dot), not just colour. Decorative — aria-hidden.
function BandBar({ smart }: { smart: SmartConfig }) {
  return (
    <Box aria-hidden flexDirection="column" paddingLeft={2}>
      <Text dimColor>{AXIS}</Text>
      <Box>
        {HOURS.map((hr) => {
          const lit = hr >= smart.workStart && hr < smart.workEnd;
          return (
            <Text key={hr} color={lit ? 'green' : 'gray'} dimColor={!lit}>
              {lit ? '█' : '·'}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

// Fixed mode: 24 hour cells, reflowed into rows of `gridCols` to fit the available
// width. Selected hours wear brackets ("[08]" vs " 08 ") so selection survives without
// colour; the cursor cell is inverse. Decorative — aria-hidden; the summary line below
// carries the same information.
function HourGrid({
  schedule,
  focused,
  hourCursor,
  gridCols,
}: {
  schedule: number[];
  focused: boolean;
  hourCursor: number;
  gridCols: number;
}) {
  const rows = chunk(HOURS, gridCols);
  return (
    <Box aria-hidden flexDirection="column" paddingLeft={2}>
      {rows.map((row) => (
        <Box key={row[0]}>
          {row.map((hr) => {
            const sel = schedule.includes(hr);
            const cur = focused && hr === hourCursor;
            return (
              <Text key={hr} color={sel ? 'green' : undefined} bold={sel} inverse={cur}>
                {sel ? `[${pad2(hr)}]` : ` ${pad2(hr)} `}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

function HoursCard({
  config,
  agentId,
  focusedKey,
  hourCursor,
  gridCols,
}: {
  config: Config;
  agentId: ProviderId;
  focusedKey: string;
  hourCursor: number;
  gridCols: number;
}) {
  const title = `HOURS · ${agentId}`;
  const active = HOURS_KEYS.includes(focusedKey);
  if (config.mode === 'smart') {
    return (
      <Card title={title} hint="p switches agent" active={active}>
        <BandBar smart={config.smart} />
        <SettingRow
          focused={focusedKey === 'workStart'}
          label="Work start"
          ariaValue={`${pad2(config.smart.workStart)}:00`}
        >
          <Choice
            value={`${pad2(config.smart.workStart)}:00`}
            focused={focusedKey === 'workStart'}
          />
        </SettingRow>
        <SettingRow
          focused={focusedKey === 'workEnd'}
          label="Work end"
          ariaValue={`${pad2(config.smart.workEnd)}:00`}
        >
          <Choice value={`${pad2(config.smart.workEnd)}:00`} focused={focusedKey === 'workEnd'} />
        </SettingRow>
        <SettingRow
          focused={focusedKey === 'weeklyStop'}
          label="Weekly stop"
          ariaValue={`${config.smart.weeklyStopPercent} percent`}
        >
          <Choice
            value={`${config.smart.weeklyStopPercent}%`}
            focused={focusedKey === 'weeklyStop'}
          />
        </SettingRow>
      </Card>
    );
  }

  const focused = focusedKey === 'schedule';
  const selected = config.schedule.length
    ? config.schedule.map((h) => `${pad2(h)}:00`).join(', ')
    : 'none (idle)';
  return (
    <Card title={title} hint="p switches agent" active={active}>
      <HourGrid
        schedule={config.schedule}
        focused={focused}
        hourCursor={hourCursor}
        gridCols={gridCols}
      />
      <Box
        aria-label={`Hours. Selected: ${selected}. Cursor at ${pad2(hourCursor)}:00.`}
        aria-state={focused ? { selected: true } : undefined}
      >
        <Pointer focused={focused} />
        <Text bold={focused} dimColor={!focused}>
          {`Selected: ${selected}`}
        </Text>
      </Box>
    </Card>
  );
}

export function ScheduleSection({
  config,
  agentId,
  focusedKey,
  hourCursor,
  gridCols,
  wide,
}: {
  config: Config;
  agentId: ProviderId;
  focusedKey: string;
  hourCursor: number;
  gridCols: number;
  wide: boolean;
}) {
  return (
    <Split
      wide={wide}
      left={<SharedCard config={config} focusedKey={focusedKey} />}
      right={
        <HoursCard
          config={config}
          agentId={agentId}
          focusedKey={focusedKey}
          hourCursor={hourCursor}
          gridCols={gridCols}
        />
      }
    />
  );
}
