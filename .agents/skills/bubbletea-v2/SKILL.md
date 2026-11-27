---
name: bubbletea-v2
description: How to build and test the agent-warmup terminal UI (internal/tui) with Bubble Tea v2, Lip Gloss v2, and Bubbles v2 (charm.land module paths). Covers Model/Update/View, async work with tea.Cmd, WindowSizeMsg layout, adaptive light and dark colors, key bindings with help, golden tests, and accessibility. Use when you change anything in internal/tui or review a TUI diff.
---

# Bubble Tea v2 in agent-warmup

The modules are `charm.land/bubbletea/v2`, `charm.land/lipgloss/v2`, and `charm.land/bubbles/v2`. The v1 paths (`github.com/charmbracelet/bubbletea`) and many blog examples do not match the v2 API. If you are not sure, read the source in `$(go env GOMODCACHE)/charm.land/`.

This skill holds the rules of this repo. For the full v2 API of Bubble Tea, Bubbles, and Lip Gloss, load the `charm-tui` skill.

## The v2 API in short

```go
type model struct {
	width, height int
	keys          keyMap
	help          help.Model
	isDark        bool
}

func (m model) Init() tea.Cmd { return tea.RequestBackgroundColor }

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.help.SetWidth(msg.Width)
	case tea.BackgroundColorMsg:
		m.isDark = msg.IsDark()
	case tea.KeyPressMsg:
		if key.Matches(msg, m.keys.Quit) {
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m model) View() tea.View {
	v := tea.NewView(m.render())
	v.AltScreen = true
	return v
}
```

- `View()` returns a `tea.View`, not a string. Set `AltScreen`, `WindowTitle`, and `Cursor` on the view, not with program options.
- Keys arrive as `tea.KeyPressMsg`. Match them with `key.Matches(msg, binding)`. `msg.String()` gives names like `"ctrl+c"`, `"enter"`, `"space"`.

## Rules

- Keep `Update` fast and free of I/O. Do slow work (probe, detect, save the configuration, apply the scheduler) in a `tea.Cmd` that returns a result message. Group commands with `tea.Batch`.
- Call domain packages (`config`, `scheduler`, `warmup`, `detect`) from commands. Never run `exec` or read files from `View`.
- Run one job at a time through `model.start`, which `jobs` tracks, so `Run` waits after quit for a canceled warmup to record its result.
- Keep the rules in the domain packages. The lanes come from `warmup.Timeline`, a pure function with the clock as input. `tui` draws its segments and never repeats a decide rule.
- Define each action once in `actions.go`. The lane keys (`laneKeys`), the edit panel rows, and the `/` command line all call `dispatch` with the action name and its arguments, so a key and its command cannot drift apart.
- Compute the layout from the latest `WindowSizeMsg`. Render nothing that depends on size before the first one arrives.
- The UI must fit 80x24. Truncate or wrap long values (paths, models) with `lipgloss.Width` and `ansi.Truncate`. Do not let a line wrap by accident.
- Define styles in one file. Pick light or dark values with `lipgloss.LightDark(m.isDark)(light, dark)` after the `tea.BackgroundColorMsg` arrives.
- Declare every binding once in a `keyMap` with `key.NewBinding(key.WithKeys("s"), key.WithHelp("s", "save and apply"))`. Implement `ShortHelp` and `FullHelp`, and render them with `help.Model.View(keys)`. The help text and the handled keys then cannot drift apart.

## Accessibility

- Never show state with color only. Pair each color with a symbol or word: `● enabled` / `○ disabled`, `✓` / `✗`, `ACTIVE` / `inactive`.
- Respect `NO_COLOR`. Lip Gloss detects the color profile from the environment, so do not force a profile.
- Mark the focused row with a symbol (`▸`) as well as a style.
- Keep every action reachable from the keyboard with one documented key, and show the key map with `?`.

## Tests

- Test `Update` and `View` directly first. They are plain functions: build a model, send messages, and check the new model and the rendered string.

```go
m := newModel(cfg)
next, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
next, _ = next.Update(tea.KeyPressMsg{Code: tea.KeySpace})
got := next.View().Content
```

- Check the rendered frame against a golden file in `testdata/` with `github.com/charmbracelet/x/exp/golden` (`golden.RequireEqual(t, []byte(got))`). Regenerate with `go test ./internal/tui -update`, and read the diff before you commit it.
- Render goldens at 80x24, 120x32, and 160x40. `TestRenderFits` checks every screen with all seven agents enabled: the frame height is exact and no line is wider than the terminal. Strip color in goldens (set `NO_COLOR=1` with `t.Setenv`) so they show layout and text, not escape codes.
- Use `github.com/charmbracelet/x/exp/teatest/v2` only for a full program flow (`teatest.NewTestModel(t, m, teatest.WithInitialTermSize(80, 24))`, `tm.Send`, `tm.WaitFinished`).
- Return commands from `Update` and run them in the test (`msg := cmd()`) instead of waiting on real timers.
