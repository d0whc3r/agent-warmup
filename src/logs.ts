// Log writing + age-based retention for the warmup log directory. Everything the
// warmup emits lives under LOG_DIR; this module keeps it bounded by time so the
// folder never grows without limit.
import fs from 'node:fs';
import path from 'node:path';
import { formatStamp, parseStampMs } from './time.js';
import { LOG_DIR, WARMUP_LOG, CRON_LOG } from './paths.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Retention in days. Env-overridable so the arm script and the CLI agree on one knob.
const RETENTION_DAYS = Number(process.env.WARMUP_LOG_RETENTION_DAYS) || 14;

// Rolling logs are trimmed line-by-line by their [yyyy-MM-dd HH:mm:ss] prefix.
const ROLLING_LOGS = [
  WARMUP_LOG,
  CRON_LOG,
  path.join(LOG_DIR, 'launchd.out.log'),
  path.join(LOG_DIR, 'launchd.err.log'),
];

// Backstop for rolling logs that carry no parseable timestamps (e.g. raw launchd
// capture): keep only the last N lines so they still can't grow unbounded.
const MAX_UNTIMESTAMPED_LINES = 2000;

const STAMP_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/;

// Append a timestamped line to warmup.log. Best-effort: logging must never throw.
export function appendLog(now: Date, line: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(WARMUP_LOG, `[${formatStamp(now)}] ${line}\n`);
  } catch {
    /* logging is best-effort */
  }
}

// Keep only lines at or after `cutoffMs`. A line's instant is the most recent
// [timestamp] prefix at or before it, so continuation lines (pane dumps, stack
// traces) ride along with their entry. If no timestamp is found anywhere, fall
// back to the last `maxLines` lines. Pure + testable — no I/O.
export function retainRecentLines(
  text: string,
  cutoffMs: number,
  maxLines = MAX_UNTIMESTAMPED_LINES,
): string {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // drop trailing newline's empty
  let sawStamp = false;
  let keeping = false;
  const out: string[] = [];
  for (const line of lines) {
    const m = STAMP_RE.exec(line);
    if (m) {
      sawStamp = true;
      const ms = parseStampMs(m[1]);
      keeping = ms != null && ms >= cutoffMs;
    }
    if (keeping) out.push(line);
  }
  const kept = sawStamp ? out : lines.slice(-maxLines);
  return kept.length ? kept.join('\n') + '\n' : '';
}

// Delete log content older than `days`: trim each rolling log by line timestamp
// and remove whole pane-*.txt captures by modification time.
export function pruneLogs(now: Date = new Date(), days: number = RETENTION_DAYS): void {
  const cutoff = now.getTime() - days * DAY_MS;
  for (const file of ROLLING_LOGS) pruneRollingLog(file, cutoff);
  prunePaneFiles(cutoff);
}

function pruneRollingLog(file: string, cutoffMs: number): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // missing → nothing to prune
  }
  const next = retainRecentLines(text, cutoffMs);
  if (next !== text) fs.writeFileSync(file, next);
}

function prunePaneFiles(cutoffMs: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(LOG_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!/^pane-.*\.txt$/.test(name)) continue;
    const p = path.join(LOG_DIR, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoffMs) fs.unlinkSync(p);
    } catch {
      /* raced with another prune; fine */
    }
  }
}
