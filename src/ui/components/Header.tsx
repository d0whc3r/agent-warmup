// Panel title plus the live status badge and a one-line subtitle. Multi-provider:
// shows the selected provider id next to the title so the user always knows
// which provider's settings they're editing.
import { Box, Text } from 'ink';
import type { MultiConfig, Status } from '../../types.js';

export function Header({ config, status }: { config: MultiConfig; status: Status }) {
  const sel = config.shared.selectedProvider;
  const selProvider = config.providers[sel];
  const subtitle = `${status.view.mode} mode · ${sel}${selProvider ? ` (${selProvider.model})` : ''}${status.nextRun ? ` · next run ${status.nextRun}` : ' · not scheduled'}`;
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          claude-warmup
          {config.shared.providers.length > 1
            ? ` (${config.shared.providers.length} providers)`
            : ''}
        </Text>
        <Text
          bold
          color={status.active ? 'green' : 'red'}
          aria-label={status.active ? 'status: active' : 'status: inactive'}
        >
          {status.active ? '● ACTIVE' : '○ inactive'}
        </Text>
      </Box>
      <Text dimColor>{subtitle}</Text>
    </Box>
  );
}
