// The always-present settings block: mode, scheduler, model and the inline-editable
// tmux session name. Multi-provider: model and tmux session bind to the selected
// provider (the rest are shared). Every row is a SettingRow, so focus + screen-
// reader semantics are handled uniformly. The card border brightens while any of
// these rows is focused.
import { Text } from 'ink';

import type { Config } from '../../types.js';
import { Card, Choice, SettingRow } from './primitives.jsx';

const SETTINGS_KEYS = ['mode', 'scheduler', 'model', 'tmux'];

export function SettingsSection({
  config,
  focusedKey,
  editing,
  editBuffer,
}: {
  config: Config;
  focusedKey: string;
  editing: boolean;
  editBuffer: string;
}) {
  return (
    <Card title="SETTINGS" active={SETTINGS_KEYS.includes(focusedKey)}>
      <SettingRow focused={focusedKey === 'mode'} label="Mode" ariaValue={config.mode}>
        <Choice value={config.mode} focused={focusedKey === 'mode'} />
      </SettingRow>
      <SettingRow
        focused={focusedKey === 'scheduler'}
        label="Scheduler"
        ariaValue={config.scheduler}
      >
        <Choice value={config.scheduler} focused={focusedKey === 'scheduler'} />
      </SettingRow>
      <SettingRow focused={focusedKey === 'model'} label="Model" ariaValue={String(config.model)}>
        <Choice value={String(config.model)} focused={focusedKey === 'model'} />
      </SettingRow>
      <SettingRow
        focused={focusedKey === 'tmux'}
        label="tmux session"
        ariaValue={editing ? editBuffer : config.tmuxSession}
      >
        {editing ? (
          <Text color="cyan">
            {editBuffer}
            <Text aria-hidden inverse>
              {' '}
            </Text>
          </Text>
        ) : (
          <Text>{config.tmuxSession}</Text>
        )}
      </SettingRow>
    </Card>
  );
}
