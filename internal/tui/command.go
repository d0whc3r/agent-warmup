package tui

import (
	"slices"
	"strings"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"

	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/provider"
)

const commandPrompt = "/ "

// openPrompt opens the text input: the command line, or a panel field with
// its current value.
func (m model) openPrompt(p *prompt, value string) (tea.Model, tea.Cmd) {
	m.prompt = p
	m.note = note{}
	m.input.Reset()
	m.input.Prompt = commandPrompt
	if p.action != "" {
		m.input.Prompt = p.action + ": "
	}
	m.input.ShowSuggestions = p.action == ""
	m.input.SetValue(value)
	m.input.CursorEnd()
	m.input.SetWidth(max(m.width-len(m.input.Prompt)-1, 1))
	m.suggest()
	return m, m.input.Focus()
}

// promptKey edits the input. Enter runs it. A failed run keeps the input
// open with its text, under the error.
func (m model) promptKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, keys.Close):
		m.prompt = nil
		m.input.Blur()
		return m, nil
	case key.Matches(msg, keys.Confirm):
		next, cmd, ok := m.submit()
		if !ok {
			return next, nil
		}
		next.prompt = nil
		next.input.Blur()
		return next, cmd
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	m.suggest()
	return m, cmd
}

func (m model) submit() (model, tea.Cmd, bool) {
	value := m.input.Value()
	if m.prompt.action == "" {
		return m.runLine(value)
	}
	return m.dispatch(m.prompt.action, append(slices.Clone(m.prompt.args), value))
}

func (m *model) suggest() {
	if m.prompt == nil || m.prompt.action != "" {
		return
	}
	m.input.SetSuggestions(completions(m.input.Value()))
}

// completions lists the command lines that complete the last word of line.
func completions(line string) []string {
	head, word, choices := completeWord(line)
	var out []string
	for _, c := range choices {
		if strings.HasPrefix(c, word) {
			out = append(out, head+c)
		}
	}
	return out
}

// completeWord splits line into the words before the last one, the last
// word, and the values that word can take.
func completeWord(line string) (head, word string, choices []string) {
	words := strings.Fields(line)
	if line == "" || strings.HasSuffix(line, " ") {
		words = append(words, "")
	}
	last := len(words) - 1
	if last > 0 {
		head = strings.Join(words[:last], " ") + " "
	}
	if last == 0 {
		for _, a := range actions {
			choices = append(choices, a.name)
		}
		return head, words[last], choices
	}
	a, ok := findAction(words[0])
	if !ok || last > len(a.args) {
		return head, words[last], nil
	}
	return head, words[last], argChoices(a.args[last-1], words)
}

func argChoices(kind argKind, words []string) []string {
	switch kind {
	case argAgent:
		return names(domain.ProviderIDs)
	case argModel:
		id, err := domain.ParseProviderID(words[1])
		if err != nil {
			return nil
		}
		return provider.Get(id).ModelChoices()
	case argValue:
	}
	return nil
}

func names[T ~string](list []T) []string {
	out := make([]string, len(list))
	for i, v := range list {
		out[i] = string(v)
	}
	return out
}

// commandHint is what the help line shows under the command line: the
// values the current word can take, else the usage of the command.
func (m model) commandHint() string {
	_, word, choices := completeWord(m.input.Value())
	var match []string
	for _, c := range choices {
		if strings.HasPrefix(c, word) {
			match = append(match, c)
		}
	}
	if len(match) > 0 {
		return strings.Join(match, " ")
	}
	words := strings.Fields(m.input.Value())
	if len(words) == 0 {
		return ""
	}
	if a, ok := findAction(words[0]); ok {
		return strings.TrimSpace(a.name+" "+a.usage) + " · " + a.help
	}
	return ""
}
