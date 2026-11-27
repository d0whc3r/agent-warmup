package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
)

// argKind names what an action argument holds, for the command completion.
type argKind string

const (
	argAgent argKind = "agent"
	argModel argKind = "model"
	argValue argKind = "value"
)

// action is one thing the UI can do. Keys, the edit panel, and the command
// line all run actions through dispatch, so each one is defined once here.
type action struct {
	name  string
	usage string // the arguments, as the help shows them
	help  string
	args  []argKind
	run   func(m model, args []string) (model, tea.Cmd, error)
}

var actions = []action{
	{"toggle", "<agent>", "turn an agent on or off", []argKind{argAgent}, edit(effectSchedule, toggleAgent)},
	{"enable", "<agent>", "turn an agent on", []argKind{argAgent}, edit(effectSchedule, enableAgent)},
	{"disable", "<agent>", "turn an agent off", []argKind{argAgent}, edit(effectSchedule, disableAgent)},
	{"model", "<agent> [model]", "set the model, or pick the next one", []argKind{argAgent, argModel}, edit(effectConfig, setModel)},
	{"binary", "<agent> <path>", "set the binary path", []argKind{argAgent, argValue}, edit(effectConfig, setBinary)},
	{"hours", "<agent> <start>-<end>", "set the work hours", []argKind{argAgent, argValue}, edit(effectSchedule, setHours)},
	{"weekly", "<agent> <percent>", "skip warmups above this weekly use", []argKind{argAgent, argValue}, edit(effectConfig, setWeekly)},
	{"detect", "<agent>", "find the binary and save its path", []argKind{argAgent}, detectAction},
	{"run", "", "warm every enabled agent now", nil, job(jobRun)},
	{"apply", "", "install the scheduler with this config", nil, job(jobApply)},
	{"stop", "", "remove the schedulers", nil, job(jobStop)},
	{"refresh", "", "read the scheduler, cache, and log again", nil, job(jobRefresh)},
	{"edit", "[agent]", "open the edit panel", []argKind{argAgent}, openPanel},
	{"logs", "", "view warmup.log", nil, openLogs},
	{"help", "", "show every key and command", nil, openHelp},
	{"quit", "", "leave the UI", nil, quit},
}

func findAction(name string) (action, bool) {
	for _, a := range actions {
		if a.name == name {
			return a, true
		}
	}
	return action{}, false
}

// dispatch runs the named action. On error the model keeps its old state,
// shows the error in full, and ok is false.
func (m model) dispatch(name string, args []string) (next model, cmd tea.Cmd, ok bool) {
	a, found := findAction(name)
	if !found {
		m.note = note{noteFail, fmt.Sprintf("unknown command %q. Press ? for the list", name)}
		return m, nil, false
	}
	next, cmd, err := a.run(m, args)
	if err != nil {
		m.note = note{noteFail, a.name + ": " + err.Error()}
		return m, nil, false
	}
	return next, cmd, true
}

// runLine runs a command line such as "hours claude 8-18".
func (m model) runLine(line string) (model, tea.Cmd, bool) {
	words := strings.Fields(line)
	if len(words) == 0 {
		return m, nil, true
	}
	return m.dispatch(words[0], words[1:])
}

func job(name string) func(m model, _ []string) (model, tea.Cmd, error) {
	return func(m model, _ []string) (model, tea.Cmd, error) { return m.start(name, m.jobCmd(name)) }
}

func detectAction(m model, args []string) (model, tea.Cmd, error) {
	id, err := agentArg(args)
	if err != nil {
		return m, nil, err
	}
	return m.start(jobDetect, m.detectCmd(id))
}

func openPanel(m model, args []string) (model, tea.Cmd, error) {
	if len(args) > 0 {
		id, err := agentArg(args)
		if err != nil {
			return m, nil, err
		}
		m.sel = agentIndex(id)
	}
	m.focus, m.panelRow = focusPanel, 0
	return m, nil, nil
}

func openHelp(m model, _ []string) (model, tea.Cmd, error) {
	m.focus = focusHelp
	return m, nil, nil
}

func quit(m model, _ []string) (model, tea.Cmd, error) { return m, tea.Quit, nil }
