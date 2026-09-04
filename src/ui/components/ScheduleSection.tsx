// The schedule block is mode-dependent. Both modes expose a TEXT summary that is the
// accessible source of truth (read by everyone and by screen readers); the glyph art
// — the smart-mode band bar and the fixed-mode hour grid — is aria-hidden, so the
// screen reader hears the summary instead of a wall of block characters.
import { Box, Text } from 'ink';

import { pad2 } from '../../format.js';
import type { Config, SmartConfig } from '../../types.js';
import { AXIS, chunk, HOURS } from '../model.js';
import { Card, Choice, Pointer, SettingRow } from './primitives.jsx';

const SMART_KEYS = ['workStart', 'workEnd', 'tick', 'weeklyStop'];

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

export function ScheduleSection({
  config,
  focusedKey,
  hourCursor,
  gridCols,
}: {
  config: Config;
  focusedKey: string;
  hourCursor: number;
  gridCols: number;
}) {
  if (config.mode === 'smart') {
    return (
      <Card title="SCHEDULE" hint="usage-aware" active={SMART_KEYS.includes(focusedKey)}>
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
          focused={focusedKey === 'tick'}
          label="Tick"
          ariaValue={`${config.smart.tickMinutes} min`}
        >
          <Choice value={`${config.smart.tickMinutes}m`} focused={focusedKey === 'tick'} />
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
    <Card title="SCHEDULE" active={focused}>
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
