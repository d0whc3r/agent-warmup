// What the warmup needs to reach ONE agent: the model to spend, the CLI binary to
// spawn (with a marker for whether that path actually works) and the tmux session
// name. The agent is the one under the AGENTS cursor, and its id is in the card
// title, so it is always clear whose settings are on screen. Every row is a
// SettingRow, so focus + screen-reader semantics are handled uniformly.
import { Text } from 'ink';

import { tildify } from '../../format.js';
import type { ProviderId } from '../../types.js';
import { Card, Choice, SettingRow } from './primitives.jsx';

const SETTINGS_KEYS = ['model', 'binary', 'tmux'];

// The inline text editor: the buffer plus a block cursor (aria-hidden, since the
// row's aria-label already carries the buffer).
function EditField({ value }: { value: string }) {
  return (
    <Text color="cyan">
      {value}
      <Text aria-hidden inverse>
        {' '}
      </Text>
    </Text>
  );
}

export function SettingsSection({
  agentId,
  model,
  binary,
  binaryOk,
  tmuxSession,
  focusedKey,
  editKey,
  editBuffer,
}: {
  agentId: ProviderId;
  model: string;
  binary: string;
  binaryOk: boolean;
  tmuxSession: string;
  focusedKey: string;
  editKey: string | null;
  editBuffer: string;
}) {
  const binaryLabel = binary ? tildify(binary) : 'not set';
  return (
    <Card title={`SETTINGS · ${agentId}`} active={SETTINGS_KEYS.includes(focusedKey)}>
      <SettingRow focused={focusedKey === 'model'} label="Model" ariaValue={model}>
        <Choice value={model} focused={focusedKey === 'model'} />
      </SettingRow>
      <SettingRow
        focused={focusedKey === 'binary'}
        label="Binary"
        ariaValue={
          editKey === 'binary' ? editBuffer : `${binaryLabel} (${binaryOk ? 'found' : 'not found'})`
        }
      >
        {editKey === 'binary' ? (
          <EditField value={editBuffer} />
        ) : (
          <Text>
            <Text aria-hidden color={binaryOk ? 'green' : 'red'}>
              {binaryOk ? '✓ ' : '✗ '}
            </Text>
            {binaryLabel}
          </Text>
        )}
      </SettingRow>
      <SettingRow
        focused={focusedKey === 'tmux'}
        label="tmux session"
        ariaValue={editKey === 'tmux' ? editBuffer : tmuxSession}
      >
        {editKey === 'tmux' ? <EditField value={editBuffer} /> : <Text>{tmuxSession}</Text>}
      </SettingRow>
    </Card>
  );
}
