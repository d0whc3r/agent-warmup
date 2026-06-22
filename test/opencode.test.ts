import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatsCost } from '../src/providers/opencode.js';

// A realistic `opencode stats --days 7 --models 1` capture. The model column
// is left-padded; the cost column is right-padded; values use the
// $X.YY format that `opencode stats` emits on the current build.
const SAMPLE = `OpenCode Go weekly stats (2026-06-15 → 2026-06-22):
  claude-sonnet-4           42,300 in / 18,200 out   $4.21
  opencode-go/deepseek-v4-flash     1,234 in / 567 out   $0.12
  gpt-4o                    120 in / 90 out   $0.05
`;

test('parseStatsCost reads the $X.YY format (regression: $ must be escaped)', () => {
  // Pre-fix, the first regex was /$\s*([0-9]+...)/ — in JS `$` is the
  // end-of-string anchor, so $0.12 / $1.23 / $4.21 always returned null and
  // the probe silently fell back to "no usage yet" (skipping the weekly cap
  // check entirely). Locking the fix in.
  assert.equal(parseStatsCost(SAMPLE, 'opencode-go/deepseek-v4-flash'), 0.12);
  assert.equal(parseStatsCost(SAMPLE, 'gpt-4o'), 0.05);
  assert.equal(parseStatsCost(SAMPLE, 'claude-sonnet-4'), 4.21);
});

test('parseStatsCost also accepts the USD X.YY format', () => {
  // Future-proofs against opencode changing its format to spell out "USD"
  // (the comment in opencode.ts explicitly says both shapes are expected).
  const usd = '  gpt-4o     120 in / 90 out   USD 4.56\n';
  assert.equal(parseStatsCost(usd, 'gpt-4o'), 4.56);
  // No space between USD and the number should still match.
  const usdTight = '  gpt-4o     120 in / 90 out   USD4.56\n';
  assert.equal(parseStatsCost(usdTight, 'gpt-4o'), 4.56);
});

test('parseStatsCost strips the opencode-go/ prefix before matching', () => {
  // WARMUP_OPENCODE_MODEL is conventionally "opencode-go/<model>"; the parser
  // slices the prefix so a needle of either form finds the row.
  const withPrefix = parseStatsCost(SAMPLE, 'opencode-go/deepseek-v4-flash');
  const bare = parseStatsCost(SAMPLE, 'deepseek-v4-flash');
  assert.equal(withPrefix, bare);
  assert.equal(bare, 0.12);
});

test('parseStatsCost returns null when the model is not in the output', () => {
  assert.equal(parseStatsCost(SAMPLE, 'no-such-model'), null);
});

test('parseStatsCost returns null for empty input', () => {
  assert.equal(parseStatsCost('', 'deepseek-v4-flash'), null);
  // A line with the right model name but no cost also returns null.
  assert.equal(
    parseStatsCost('  deepseek-v4-flash      1,234 in / 567 out\n', 'deepseek-v4-flash'),
    null,
  );
});

test('parseStatsCost handles whole-dollar amounts (no decimals)', () => {
  const out = '  deepseek-v4-flash      1,234 in / 567 out   $1\n';
  assert.equal(parseStatsCost(out, 'deepseek-v4-flash'), 1);
});
