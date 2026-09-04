// The list of action rows (save, run, stop, logs, quit). Each is a button to the
// screen reader (aria-role) and the focused one is marked selected, so SR output
// reads e.g. "(selected) button: Save & apply". Focus is shown visually with the
// pointer + bold weight, never colour alone; the card border brightens while one of
// the actions is focused. The single-key accelerator is underlined inside the label
// (a menu mnemonic); the underline is purely decorative — the parent Box's aria-label
// gives the screen reader the whole plain label, so the styling never reaches it.
import { Box, Text } from 'ink';

import type { Row } from '../model.js';
import { Card, Pointer } from './primitives.jsx';

// Render the label with its accelerator character underlined. Slices are string
// values, so their spaces survive (unlike bare JSX whitespace). Falls back to a plain
// label when there is no accelerator or it isn't a character of the label.
function AccelLabel({
  label,
  accel,
  focused,
}: {
  label: string;
  accel?: string;
  focused: boolean;
}) {
  const color = focused ? 'cyan' : undefined;
  const i = accel ? label.toLowerCase().indexOf(accel.toLowerCase()) : -1;
  return (
    <Text bold={focused} color={color}>
      {i < 0 ? (
        label
      ) : (
        <>
          {label.slice(0, i)}
          <Text underline>{label[i]}</Text>
          {label.slice(i + 1)}
        </>
      )}
    </Text>
  );
}

export function ActionsSection({ actions, focusedKey }: { actions: Row[]; focusedKey: string }) {
  return (
    <Card title="ACTIONS" active={actions.some((a) => a.key === focusedKey)}>
      {actions.map((a) => {
        const focused = a.key === focusedKey;
        return (
          <Box
            key={a.key}
            aria-role="button"
            aria-label={a.label}
            aria-state={focused ? { selected: true } : undefined}
          >
            <Pointer focused={focused} />
            <AccelLabel label={a.label} accel={a.accel} focused={focused} />
          </Box>
        );
      })}
    </Card>
  );
}
