// Display formatting shared by the CLI output (print-status.js) and the Ink TUI.
// Kept dependency-free so both the headless commands and the UI can import it.
import os from 'node:os';

// Zero-pad a number to two digits, e.g. 8 -> "08" (used for hours everywhere).
export const pad2 = (n: number): string => String(n).padStart(2, '0');

// Humanize the usage-cache age: "45m ago" under an hour, "3h ago" beyond.
export const ago = (m: number): string => (m >= 60 ? `${Math.round(m / 60)}h ago` : `${m}m ago`);

// Collapse the home prefix back to "~" so long binary paths fit a TUI row.
export const tildify = (p: string, home = os.homedir()): string =>
  home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
