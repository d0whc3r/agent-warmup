// The two-line footer. Line one is state/feedback: the inline editing prompt, the
// unsaved-changes nudge, or the last action's confirmation (every value change emits
// one, so there is always feedback). Line two is the contextual key hint for the
// focused row. State is carried by words + a "●" marker, not colour alone.
import { Box, Text } from 'ink';

export function StatusBar({
  editing,
  dirty,
  message,
  hint,
}: {
  editing: boolean;
  dirty: boolean;
  message: string;
  hint: string;
}) {
  if (editing) {
    return (
      <Box marginTop={1}>
        <Text color="cyan">Renaming session — enter saves · esc cancels</Text>
      </Box>
    );
  }

  let text: string;
  let color: string | undefined;
  let dim = false;
  if (dirty) {
    text = message ? `● unsaved · ${message}` : '● unsaved — choose "Save & apply"';
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
      <Text dimColor>{hint}</Text>
    </Box>
  );
}
