package tui

import (
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/provider"
)

// effect says whether a saved edit changes what the scheduler installs.
type effect string

const (
	effectConfig   effect = "config"
	effectSchedule effect = "schedule"
)

// editFn returns the edited config and the text of the saved note.
type editFn func(cfg domain.Config, args []string) (domain.Config, string, error)

// edit turns an editFn into an action run that saves the result.
func edit(e effect, fn editFn) func(m model, args []string) (model, tea.Cmd, error) {
	return func(m model, args []string) (model, tea.Cmd, error) {
		next, text, err := fn(m.cfg, args)
		if err != nil {
			return m, nil, err
		}
		m, err = m.save(next, e, text)
		return m, nil, err
	}
}

// save validates and writes next through config.Save. On error the model
// keeps the old config.
func (m model) save(next domain.Config, e effect, text string) (model, error) {
	if err := config.Save(m.deps.Paths, next); err != nil {
		return m, err
	}
	m.cfg = next
	m.note = note{noteOK, "saved: " + text}
	if e == effectSchedule {
		m.unapplied = true
	}
	m.reproject()
	return m, nil
}

func agentArg(args []string) (domain.ProviderID, error) {
	if len(args) == 0 {
		return "", errors.New("missing <agent>")
	}
	return domain.ParseProviderID(args[0])
}

// agentValue reads "<agent> <value...>". The value keeps its inner spaces,
// so validation sees exactly what was typed.
func agentValue(args []string, name string) (domain.ProviderID, string, error) {
	id, err := agentArg(args)
	if err != nil {
		return "", "", err
	}
	if len(args) < 2 {
		return "", "", fmt.Errorf("missing <%s>", name)
	}
	return id, strings.Join(args[1:], " "), nil
}

func atoi(s, name string) (int, error) {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("%s: %q is not a whole number", name, s)
	}
	return n, nil
}

func toggleAgent(cfg domain.Config, args []string) (domain.Config, string, error) {
	id, err := agentArg(args)
	if err != nil {
		return cfg, "", err
	}
	if cfg.Providers[id].Enabled {
		return disableAgent(cfg, args)
	}
	return enableAgent(cfg, args)
}

func enableAgent(cfg domain.Config, args []string) (domain.Config, string, error) {
	id, err := agentArg(args)
	if err != nil {
		return cfg, "", err
	}
	return config.WithProvider(cfg, id, func(pc *domain.ProviderConfig) { pc.Enabled = true }), string(id) + " on", nil
}

func disableAgent(cfg domain.Config, args []string) (domain.Config, string, error) {
	id, err := agentArg(args)
	if err != nil {
		return cfg, "", err
	}
	return config.WithProvider(cfg, id, func(pc *domain.ProviderConfig) { pc.Enabled = false }), string(id) + " off", nil
}

// setModel sets the given model, or the next suggested one without a model.
func setModel(cfg domain.Config, args []string) (domain.Config, string, error) {
	id, err := agentArg(args)
	if err != nil {
		return cfg, "", err
	}
	model := cycle(provider.Get(id).ModelChoices(), cfg.Providers[id].Model, 1)
	if len(args) > 1 {
		model = strings.Join(args[1:], " ")
	}
	return config.WithProvider(cfg, id, func(pc *domain.ProviderConfig) { pc.Model = model }), string(id) + " model " + model, nil
}

func setBinary(cfg domain.Config, args []string) (domain.Config, string, error) {
	id, v, err := agentValue(args, "path")
	if err != nil {
		return cfg, "", err
	}
	return config.WithProvider(cfg, id, func(pc *domain.ProviderConfig) { pc.Binary = v }), string(id) + " binary " + v, nil
}

func setHours(cfg domain.Config, args []string) (domain.Config, string, error) {
	id, v, err := agentValue(args, "start>-<end")
	if err != nil {
		return cfg, "", err
	}
	from, to, found := strings.Cut(v, "-")
	if !found {
		return cfg, "", fmt.Errorf("work hours: %q is not <start>-<end>, for example 8-18", v)
	}
	start, err := atoi(from, "work start")
	if err != nil {
		return cfg, "", err
	}
	end, err := atoi(to, "work end")
	if err != nil {
		return cfg, "", err
	}
	next := config.WithProvider(cfg, id, func(pc *domain.ProviderConfig) { pc.WorkStart, pc.WorkEnd = start, end })
	return next, fmt.Sprintf("%s work hours %02d-%02d", id, start, end), nil
}

func setWeekly(cfg domain.Config, args []string) (domain.Config, string, error) {
	id, v, err := agentValue(args, "percent")
	if err != nil {
		return cfg, "", err
	}
	n, err := atoi(strings.TrimSuffix(v, "%"), "weekly stop")
	if err != nil {
		return cfg, "", err
	}
	next := config.WithProvider(cfg, id, func(pc *domain.ProviderConfig) { pc.WeeklyStopPercent = n })
	return next, fmt.Sprintf("%s skips warmups at %d%% weekly use", id, n), nil
}

// cycle returns the entry delta steps from cur, wrapping. A cur that is not
// in list counts as the position before the first entry.
func cycle[T comparable](list []T, cur T, delta int) T {
	i := slices.Index(list, cur)
	if i < 0 && delta > 0 {
		i = -1
	}
	if i < 0 && delta <= 0 {
		i = 0
	}
	n := len(list)
	return list[((i+delta)%n+n)%n]
}
