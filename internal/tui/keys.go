package tui

import (
	"strconv"
	"unicode/utf8"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
)

// keyMap holds every binding of the UI.
type keyMap struct {
	Up, Down, Left, Right key.Binding

	Toggle, Edit, Model, Weekly, Detect key.Binding
	Start, End                          key.Binding
	Run, Apply, Stop, Logs, Refresh     key.Binding

	Command, Help, Quit, Close, Confirm, Complete key.Binding
}

var keys = keyMap{
	Up:    key.NewBinding(key.WithKeys("up", "k"), key.WithHelp("↑/k", "up")),
	Down:  key.NewBinding(key.WithKeys("down", "j"), key.WithHelp("↓/j", "down")),
	Left:  key.NewBinding(key.WithKeys("left", "h"), key.WithHelp("←/h", "earlier hour")),
	Right: key.NewBinding(key.WithKeys("right", "l"), key.WithHelp("→/l", "later hour")),

	Toggle: key.NewBinding(key.WithKeys("space"), key.WithHelp("space", "on/off")),
	Edit:   key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "edit")),
	Model:  key.NewBinding(key.WithKeys("m"), key.WithHelp("m", "model")),
	Weekly: key.NewBinding(key.WithKeys("w"), key.WithHelp("w", "weekly stop")),
	Detect: key.NewBinding(key.WithKeys("d"), key.WithHelp("d", "detect binary")),

	Start: key.NewBinding(key.WithKeys("["), key.WithHelp("[", "work starts at cursor")),
	End:   key.NewBinding(key.WithKeys("]"), key.WithHelp("]", "work ends after cursor")),

	Run:     key.NewBinding(key.WithKeys("r"), key.WithHelp("r", "run now")),
	Apply:   key.NewBinding(key.WithKeys("a"), key.WithHelp("a", "apply")),
	Stop:    key.NewBinding(key.WithKeys("x"), key.WithHelp("x", "stop schedulers")),
	Logs:    key.NewBinding(key.WithKeys("v"), key.WithHelp("v", "log")),
	Refresh: key.NewBinding(key.WithKeys("u"), key.WithHelp("u", "refresh")),

	Command:  key.NewBinding(key.WithKeys("/"), key.WithHelp("/", "command")),
	Help:     key.NewBinding(key.WithKeys("?"), key.WithHelp("?", "keys")),
	Quit:     key.NewBinding(key.WithKeys("q", "ctrl+c"), key.WithHelp("q", "quit")),
	Close:    key.NewBinding(key.WithKeys("esc"), key.WithHelp("esc", "close")),
	Confirm:  key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "save")),
	Complete: key.NewBinding(key.WithKeys("tab"), key.WithHelp("tab", "complete")),
}

// laneKey binds a key on the lanes to an action. args builds the action's
// arguments from the selection, so a key and its command do the same thing.
type laneKey struct {
	binding key.Binding
	action  string
	args    func(m model) []string
}

var laneKeys = []laneKey{
	{keys.Toggle, "toggle", selected},
	{keys.Edit, "edit", selected},
	{keys.Model, "model", func(m model) []string { return []string{m.selID(), m.nextModel(1)} }},
	{keys.Detect, "detect", selected},
	{keys.Start, "hours", func(m model) []string { return []string{m.selID(), hoursArg(m.cursor, m.selCfg().WorkEnd)} }},
	{keys.End, "hours", func(m model) []string { return []string{m.selID(), hoursArg(m.selCfg().WorkStart, m.cursor+1)} }},
	{keys.Run, "run", none},
	{keys.Apply, "apply", none},
	{keys.Stop, "stop", none},
	{keys.Logs, "logs", none},
	{keys.Refresh, "refresh", none},
	{keys.Help, "help", none},
	{keys.Quit, "quit", none},
}

func selected(m model) []string { return []string{m.selID()} }
func none(model) []string       { return nil }

func hoursArg(start, end int) string { return strconv.Itoa(start) + "-" + strconv.Itoa(end) }

// relabel returns b with another help text, for a key whose meaning depends on the focus.
func relabel(b key.Binding, desc string) key.Binding {
	b.SetHelp(b.Help().Key, desc)
	return b
}

// fullHelp is the key list of the help screen, one group per column.
func fullHelp() [][]key.Binding {
	return [][]key.Binding{
		{relabel(keys.Up, "previous agent"), relabel(keys.Down, "next agent"), keys.Left, keys.Right, keys.Start, keys.End},
		{keys.Toggle, keys.Edit, keys.Model, keys.Weekly, keys.Detect, keys.Command},
		{keys.Run, keys.Apply, keys.Stop, keys.Logs, keys.Refresh, keys.Help, keys.Quit},
	}
}

// chip is one entry of the key bar: the keys, each drawn in its own box, and
// what they do. A click on a box presses that box's key.
type chip struct {
	keys  []key.Binding
	label string
}

// one is the chip of a single binding, labeled with its help text.
func one(b key.Binding) chip { return chip{[]key.Binding{b}, b.Help().Desc} }

// pair is the chip of two bindings that share a label, such as ← and →.
func pair(a, b key.Binding, label string) chip { return chip{[]key.Binding{a, b}, label} }

// keyBar is the two lines of chips for what is open or selected. The chips
// are the bindings the handlers match, so a label cannot drift from its key.
func (m model) keyBar() [barRows][]chip {
	switch {
	case m.prompt != nil && m.prompt.action == "":
		return [barRows][]chip{{one(keys.Complete), one(relabel(keys.Confirm, "run")), one(relabel(keys.Close, "cancel"))}}
	case m.prompt != nil:
		return [barRows][]chip{{one(keys.Confirm), one(relabel(keys.Close, "cancel"))}}
	}
	switch m.focus {
	case focusPanel:
		return [barRows][]chip{
			{pair(keys.Up, keys.Down, "field"), pair(keys.Left, keys.Right, "change"), one(relabel(keys.Edit, "type")), one(keys.Detect), one(keys.Close)},
			{one(keys.Help), one(keys.Quit)},
		}
	case focusHelp:
		return [barRows][]chip{{one(keys.Close), one(keys.Quit)}}
	case focusLogs:
		return [barRows][]chip{{pair(keys.Up, keys.Down, "scroll"), one(keys.Close), one(keys.Quit)}}
	case focusLanes:
	}
	return [barRows][]chip{
		{one(keys.Toggle), one(keys.Model), pair(keys.Start, keys.End, "work start/end"), one(keys.Weekly), one(keys.Edit)},
		{pair(keys.Left, keys.Right, "hour"), one(keys.Run), one(keys.Apply), one(keys.Logs), one(keys.Command), one(keys.Help), one(keys.Quit)},
	}
}

// arrowGlyphs draw the arrow keys in a chip box.
var arrowGlyphs = map[string]string{"up": "↑", "down": "↓", "left": "←", "right": "→"}

// boxText is the text in a binding's chip box: the arrow for an arrow key,
// else the help key.
func boxText(b key.Binding) string {
	if g, ok := arrowGlyphs[b.Keys()[0]]; ok {
		return g
	}
	return b.Help().Key
}

// namedKeys are the key names that are not a printable rune.
var namedKeys = map[string]tea.KeyPressMsg{
	"space": {Code: tea.KeySpace, Text: " "},
	"enter": {Code: tea.KeyEnter},
	"esc":   {Code: tea.KeyEscape},
	"tab":   {Code: tea.KeyTab},
	"up":    {Code: tea.KeyUp},
	"down":  {Code: tea.KeyDown},
	"left":  {Code: tea.KeyLeft},
	"right": {Code: tea.KeyRight},
}

// keyPress is the key message whose String() is name, so a chip click
// matches the same binding as the key.
func keyPress(name string) tea.KeyPressMsg {
	if msg, ok := namedKeys[name]; ok {
		return msg
	}
	r, _ := utf8.DecodeRuneInString(name)
	return tea.KeyPressMsg{Code: r, Text: name}
}
