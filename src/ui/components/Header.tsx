// One-line panel header: the title on the left, the live scheduler badge on the
// right. The badge carries the next run so "is it on, and when does it fire?" is
// answered from every tab without opening the overview. State is spelt out in
// words + a filled/hollow dot, never colour alone.
import { Box, Text } from 'ink';

import type { Status } from '../../types.js';

export function Header({ status }: { status: Status }) {
  const next = status.active ? status.nextRun : null;
  return (
    <Box justifyContent="space-between">
      <Text bold color="cyan">
        agent-warmup
      </Text>
      <Text
        bold
        color={status.active ? 'green' : 'red'}
        aria-label={
          status.active ? `status: active${next ? `, next run ${next}` : ''}` : 'status: inactive'
        }
      >
        {status.active ? `● ACTIVE${next ? ` · next ${next}` : ''}` : '○ inactive'}
      </Text>
    </Box>
  );
}
