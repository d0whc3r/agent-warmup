// The "?" keyboard-help panel. A plain two-column list (keys | action) inside a card.
// Each row carries an aria-label so it reads as "key: action" to screen readers, with
// no decorative noise; the keys column is bold + cyan but the words stand on their own
// (colour is never the only signal). Toggled from the controller's showHelp state.
import { Box, Text } from 'ink';

import type { Shortcut } from '../model.js';
import { Card } from './primitives.jsx';

// Pad the keys into a fixed column so the action labels line up. Spelt as a string
// literal (computed), never JSX whitespace between elements.
const KEYS_W = 8;

export function HelpOverlay({ shortcuts }: { shortcuts: readonly Shortcut[] }) {
  return (
    <Card title="KEYBOARD SHORTCUTS">
      {shortcuts.map((s) => (
        <Box key={s.keys} aria-label={`${s.keys}: ${s.label}`}>
          <Text bold color="cyan">
            {s.keys.padEnd(KEYS_W)}
          </Text>
          <Text>{s.label}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>? or esc to close</Text>
      </Box>
    </Card>
  );
}
