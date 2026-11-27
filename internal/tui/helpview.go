package tui

import (
	"fmt"
	"strings"
)

// commandColumns is how many columns the command list uses from wideAt.
const commandColumns = 3

// helpView lists every key, then every command, then how saving works.
func (m model) helpView(w int) []string {
	m.help.SetWidth(w)
	lines := strings.Split(m.help.FullHelpView(fullHelp()), "\n")
	lines = append(lines, m.st.bold.Render("Commands")+m.st.dim.Render(" · press / and type one, tab completes"))

	cols := 2
	if w >= wideAt {
		cols = commandColumns
	}
	colW := w / cols
	rowsN := (len(actions) + cols - 1) / cols
	for r := range rowsN {
		var b strings.Builder
		for c := range cols {
			i := c*rowsN + r
			if i >= len(actions) {
				break
			}
			a := actions[i]
			fmt.Fprintf(&b, "%-*s", colW, truncate(strings.TrimSpace(a.name+" "+a.usage), colW-1))
		}
		lines = append(lines, strings.TrimRight(b.String(), " "))
	}
	lines = append(lines,
		m.st.dim.Render("Mouse: click a lane, hour, field, or key. Drag across hours to set work hours."),
		m.st.dim.Render("Edits save at once. Schedule edits show "+markPending+" unapplied until you press a."))
	return truncLines(lines, w)
}
