// The usage block -- session and weekly limits read from the cached probe.
// Multi-provider: shows the SELECTED provider's cache. Renders nothing until a
// probe has populated that provider's cache. Plain labelled text, so it reads
// identically for sighted and screen-reader users. Never holds focus, so its
// card border stays dimmed.
import { Box, Text } from 'ink';

import { ago } from '../../format.js';
import type { UsageView } from '../../types.js';
import { LABEL_W } from '../model.js';
import { Card } from './primitives.jsx';

function UsageRow({ label, value, tail }: { label: string; value: string; tail?: string | null }) {
  return (
    <Box>
      <Text>{'  '}</Text>
      <Text dimColor>{label.padEnd(LABEL_W - 2)}</Text>
      <Text color="cyan">{value}</Text>
      {tail != null ? <Text dimColor>{`   ${tail}`}</Text> : null}
    </Box>
  );
}

export function UsageSection({ usage }: { usage: UsageView | null }) {
  if (!usage) return null;
  return (
    <Card title="USAGE">
      <UsageRow label="Session" value={usage.session} />
      <UsageRow
        label="Weekly"
        value={usage.week}
        tail={usage.ageMin != null ? ago(usage.ageMin) : null}
      />
    </Card>
  );
}
