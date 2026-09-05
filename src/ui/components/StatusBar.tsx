// The footer. Line one is state/feedback: the inline editing prompt, the
// pending-apply nudge, or the last action's confirmation (every value change emits
// one, so there is always feedback). Line two is the contextual key hint for the
// focused row (omitted on read-only tabs). Line three is the global action legend,
// so save/run/stop/logs/quit are visible from every tab. State is carried by words
// + a "●" marker, not colour alone.
import { Box, Text } from 'ink';

import { LEGEND } from '../model.js';

export function StatusBar({
  editing,
  editLabel = 'Renaming session',
  dirty,
  message,
  hint,
}: {
  editing: boolean;
  editLabel?: string;
  dirty: boolean;
  message: string;
  hint: string;
}) {
  if (editing) {
    return (
      <Box marginTop={1}>
        <Text color="cyan">{`${editLabel} — enter saves · esc cancels`}</Text>
      </Box>
    );
  }

  // Every change is written to disk at once; what is pending is re-installing the
  // scheduler, which is what "s" does. Say that, not "unsaved".
  let text: string;
  let color: string | undefined;
  let dim = false;
  if (dirty) {
    text = message ? `● ${message} · s to apply` : '● changes not applied · s to apply';
    color = 'yellow';
  } else if (message) {
    text = `✓ ${message}`;
    color = 'green';
  } else {
    text = 'up to date';
    dim = true;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color} dimColor={dim}>
        {text}
      </Text>
      {hint ? <Text dimColor>{hint}</Text> : null}
      <Text dimColor>{LEGEND}</Text>
    </Box>
  );
}
