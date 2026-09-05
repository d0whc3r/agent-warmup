// The tab strip under the header. The active tab is marked by brackets + bold, never
// by colour alone, and each tab carries its jump digit so the keyboard route is
// visible without opening the help overlay. Roles are real: a tablist of tabs, so a
// screen reader announces "tablist: (selected) tab: Overview …". The strip wraps
// onto a second line on narrow terminals rather than overflowing.
import { Box, Text } from 'ink';

import type { TabDef, TabKey } from '../model.js';

export function TabBar({ tabs, active }: { tabs: readonly TabDef[]; active: TabKey }) {
  return (
    <Box aria-role="tablist" flexWrap="wrap">
      {tabs.map((tab) => {
        const on = tab.key === active;
        return (
          <Box
            key={tab.key}
            aria-role="tab"
            aria-label={tab.label}
            aria-state={on ? { selected: true } : undefined}
          >
            <Text aria-hidden bold={on} color={on ? 'cyan' : undefined} dimColor={!on}>
              {on ? `[${tab.accel} ${tab.label}]` : ` ${tab.accel} ${tab.label} `}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
