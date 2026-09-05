// Interactive terminal UI for agent-warmup, built with Ink. The panel is tabbed:
// OVERVIEW answers "how is everything doing" (scheduler state plus every agent's
// usage), AGENTS picks the agent to warm and configures how to reach it, SCHEDULE
// decides when the tick runs. Responsive: a single labelled column that reflows on
// narrow terminals, split into two side-by-side columns on wide ones. tab / shift+tab
// (or 1-3) switch tabs; the action keys (s, r, t, l, q) sit in the status-bar legend
// and, like the agent keys (p, d), work from every tab.
import { Box } from 'ink';

import type { Detection } from '../detect.js';
import type { MultiConfig, Status, UiAction } from '../types.js';
import { AgentsSection } from './components/AgentsSection.jsx';
import { Header } from './components/Header.jsx';
import { HelpOverlay } from './components/HelpOverlay.jsx';
import { OverviewSection } from './components/OverviewSection.jsx';
import { Split } from './components/primitives.jsx';
import { ScheduleSection } from './components/ScheduleSection.jsx';
import { SettingsSection } from './components/SettingsSection.jsx';
import { StatusBar } from './components/StatusBar.jsx';
import { TabBar } from './components/TabBar.jsx';
import { UsageSection } from './components/UsageSection.jsx';
import { SHORTCUTS, type TabKey } from './model.js';
import { useWarmupUi } from './useWarmupUi.js';

export default function App({
  onAction,
  initialConfig,
  initialStatus,
  initialDetections,
  initialTab,
}: {
  onAction?: (a: UiAction) => void;
  initialConfig?: MultiConfig;
  initialStatus?: Status;
  initialDetections?: readonly Detection[];
  initialTab?: TabKey;
}) {
  const ui = useWarmupUi({ onAction, initialConfig, initialStatus, initialDetections, initialTab });

  const panel = () => {
    if (ui.tab === 'agents') {
      return (
        <Split
          wide={ui.wide}
          left={
            <AgentsSection
              config={ui.multi}
              ids={ui.agentIds}
              detections={ui.detections}
              focused={ui.focusedKey === 'agents'}
              cursor={ui.agentCursor}
            />
          }
          right={
            <>
              <SettingsSection
                agentId={ui.agentId}
                model={ui.agentModel}
                binary={ui.binary}
                binaryOk={ui.binaryOk}
                tmuxSession={ui.agentTmuxSession}
                focusedKey={ui.focusedKey}
                editKey={ui.editKey}
                editBuffer={ui.editBuffer}
              />
              <UsageSection usage={ui.usage} />
            </>
          }
        />
      );
    }
    if (ui.tab === 'schedule') {
      return (
        <ScheduleSection
          config={ui.config}
          agentId={ui.agentId}
          focusedKey={ui.focusedKey}
          hourCursor={ui.hourCursor}
          gridCols={ui.gridCols}
          wide={ui.wide}
        />
      );
    }
    return (
      <OverviewSection config={ui.multi} status={ui.status} ids={ui.agentIds} wide={ui.wide} />
    );
  };

  return (
    <Box flexDirection="column" width={ui.width} paddingX={1}>
      <Header status={ui.status} />
      <TabBar tabs={ui.tabs} active={ui.tab} />
      {ui.showHelp ? <HelpOverlay shortcuts={SHORTCUTS} /> : panel()}
      <StatusBar
        editing={ui.editing}
        editLabel={ui.editLabel}
        dirty={ui.dirty}
        message={ui.message}
        hint={ui.hint}
      />
    </Box>
  );
}
