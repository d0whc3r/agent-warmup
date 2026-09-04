// Shared presentational atoms. Each carries the ARIA props that drive Ink's screen
// reader output, and each conveys state through SHAPE + WEIGHT (a pointer glyph,
// brackets, bold) rather than colour alone — so the UI still reads correctly under
// NO_COLOR, on monochrome terminals, and for colour-blind users.
//
// JSX collapses whitespace before a newline, so every significant space is a string
// literal child (e.g. {'  '}), never a bare space between elements.
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { LABEL_W } from '../model.js';

// The "▶ " gutter marking the focused row (two spaces when not, so the label column
// never shifts). aria-hidden: focus reaches the screen reader via aria-state below,
// not this glyph.
export function Pointer({ focused }: { focused: boolean }) {
  return (
    <Text aria-hidden bold color="cyan">
      {focused ? '▶ ' : '  '}
    </Text>
  );
}

// An adjustable value. When focused it shows the "‹ value ›" affordance (signalling
// ←/→ change it) in bold; otherwise it renders plain at the same width. The screen
// reader always hears the bare value via aria-label, never the brackets.
export function Choice({ value, focused }: { value: string; focused: boolean }) {
  return (
    <Text bold={focused} color={focused ? 'cyan' : undefined} aria-label={value}>
      {focused ? `‹ ${value} ›` : value}
    </Text>
  );
}

// A bordered, titled "card" grouping one section's rows. The active card (the one
// holding the focused row) gets a bright solid border and a highlighted title; the
// rest are dimmed. The border is purely visual — Ink omits borders entirely from
// screen-reader output — so cards organise the layout for sighted users without
// adding any noise for screen-reader users.
export function Card({
  title,
  hint,
  active = false,
  children,
}: {
  title: string;
  hint?: string;
  active?: boolean;
  children?: ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      borderStyle="round"
      borderColor={active ? 'cyan' : 'gray'}
      borderDimColor={!active}
    >
      <Box>
        <Text bold color={active ? 'cyan' : undefined}>
          {title}
        </Text>
        {hint != null ? <Text dimColor>{`  ${hint}`}</Text> : null}
      </Box>
      {children}
    </Box>
  );
}

// "▶ Label        value". The row's aria-label gives the screen reader the whole
// "Label: value" line (children are skipped in SR mode), and aria-state marks the
// focused row as selected so it reads e.g. "(selected) Mode: smart".
export function SettingRow({
  focused,
  label,
  ariaValue,
  children,
}: {
  focused: boolean;
  label: string;
  ariaValue: string;
  children?: ReactNode;
}) {
  return (
    <Box
      aria-label={`${label}: ${ariaValue}`}
      aria-state={focused ? { selected: true } : undefined}
    >
      <Pointer focused={focused} />
      <Text bold={focused}>{label.padEnd(LABEL_W)}</Text>
      {children}
    </Box>
  );
}
