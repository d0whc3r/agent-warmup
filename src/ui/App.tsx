// Interactive terminal UI for agent-warmup, built with Ink. Responsive: a single
// labelled column that reflows on narrow terminals, split into two side-by-side
// columns on wide ones. Multi-provider: the Header shows the selected provider;
// settings and usage are bound to it. Press 'p' in the TUI to cycle providers.
import { Box } from 'ink';
import { useWarmupUi } from './useWarmupUi.js';
import { Header } from './components/Header.jsx';
import { SettingsSection } from './components/SettingsSection.jsx';
import { ScheduleSection } from './components/ScheduleSection.jsx';
import { UsageSection } from './components/UsageSection.jsx';
import { ActionsSection } from './components/ActionsSection.jsx';
import { StatusBar } from './components/StatusBar.jsx';
import { HelpOverlay } from './components/HelpOverlay.jsx';
import { SHORTCUTS } from './model.js';
import type { Status, UiAction } from '../types.js';

export default function App({
  onAction,
  initialConfig,
  initialStatus,
}: {
  onAction?: (a: UiAction) => void;
  initialConfig?: import('../types.js').MultiConfig;
  initialStatus?: Status;
}) {
  const ui = useWarmupUi({ onAction, initialConfig, initialStatus });

  const config = (
    <>
      <SettingsSection
        config={ui.config}
        focusedKey={ui.focusedKey}
        editing={ui.editing}
        editBuffer={ui.editBuffer}
      />
      <ScheduleSection
        config={ui.config}
        focusedKey={ui.focusedKey}
        hourCursor={ui.hourCursor}
        gridCols={ui.gridCols}
      />
    </>
  );
  const aside = (
    <>
      <UsageSection usage={ui.usage} />
      <ActionsSection actions={ui.actions} focusedKey={ui.focusedKey} />
    </>
  );

  return (
    <Box flexDirection="column" width={ui.width} paddingX={1}>
      <Header config={ui.multi} status={ui.status} />
      {ui.showHelp ? (
        <HelpOverlay shortcuts={SHORTCUTS} />
      ) : ui.wide ? (
        <Box>
          <Box flexDirection="column" width="50%" paddingRight={1}>
            {config}
          </Box>
          <Box flexDirection="column" width="50%" paddingLeft={1}>
            {aside}
          </Box>
        </Box>
      ) : (
        <>
          {config}
          {aside}
        </>
      )}
      <StatusBar editing={ui.editing} dirty={ui.dirty} message={ui.message} hint={ui.hint} />
    </Box>
  );
}
