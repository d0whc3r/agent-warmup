// The agent picker: every built-in agent with its enabled state, whether it is the
// one the rest of the panel is editing, and whether its CLI was found on this
// machine. State is carried by shape ("[x]" vs "[ ]", "*" vs nothing, "found" vs
// "missing" spelt out) rather than colour alone, and every glyph is aria-hidden —
// each row's aria-label spells the same information out for screen readers.
import { Box, Text } from 'ink';

import type { Detection } from '../../detect.js';
import type { MultiConfig, ProviderId } from '../../types.js';
import { Card, Pointer } from './primitives.jsx';

const ID_W = 10;

export function AgentsSection({
  config,
  ids,
  detections,
  focused,
  cursor,
}: {
  config: MultiConfig;
  ids: readonly ProviderId[];
  detections: readonly Detection[];
  focused: boolean;
  cursor: number;
}) {
  return (
    <Card title="AGENTS" hint="* = default · p cycles" active={focused}>
      {ids.map((id, i) => {
        const provider = config.providers[id];
        if (!provider) return null;
        const found = detections.find((d) => d.id === id)?.path ?? null;
        const enabled = provider.enabled;
        const selected = config.shared.selectedProvider === id;
        const onCursor = i === cursor;
        const state = [
          enabled ? 'enabled' : 'disabled',
          selected ? 'selected' : null,
          found ? 'installed' : 'not installed',
        ]
          .filter(Boolean)
          .join(', ');
        return (
          <Box
            key={id}
            aria-label={`${id}: ${state}`}
            aria-state={focused && onCursor ? { selected: true } : undefined}
          >
            {/* The cursor stays visible (dimmed) once focus moves down to this
                agent's settings, so the list always shows whose settings are open. */}
            {focused || !onCursor ? (
              <Pointer focused={focused && onCursor} />
            ) : (
              <Text aria-hidden dimColor>
                {'▸ '}
              </Text>
            )}
            <Text aria-hidden bold={enabled} color={enabled ? 'green' : undefined}>
              {enabled ? '[x] ' : '[ ] '}
            </Text>
            <Text aria-hidden bold={selected}>
              {(selected ? `${id}*` : id).padEnd(ID_W)}
            </Text>
            <Text aria-hidden color={found ? 'cyan' : 'red'} dimColor={!found}>
              {found ? '✓ found' : '✗ missing'}
            </Text>
          </Box>
        );
      })}
    </Card>
  );
}
