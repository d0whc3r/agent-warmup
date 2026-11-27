package tui

import (
	"charm.land/lipgloss/v2"

	"github.com/d0whc3r/agent-warmup/internal/warmup"
)

// Every state has a glyph, so the UI reads the same without color.
const (
	glyphNext   = "◆"
	glyphNow    = "▼"
	glyphCursor = "▽"

	markSelected = "▸"
	markOn       = "●"
	markOff      = "○"
	markChecking = "◌"
	markPending  = "◇"
	markOK       = "✓ "
	markFail     = "✗ "
	markInfo     = "› "
	ellipsis     = "…"
)

// glyphs maps each segment kind to its lane cell.
var glyphs = map[warmup.SegmentKind]string{
	warmup.SegmentOff:       "·",
	warmup.SegmentWork:      "░",
	warmup.SegmentPredicted: "▒",
	warmup.SegmentArmed:     "█",
}

// styles is every style of the UI, built once per background color.
type styles struct {
	brand, bold, dim  lipgloss.Style
	good, bad, warn   lipgloss.Style
	cells             map[warmup.SegmentKind]lipgloss.Style
	next, cursor, now lipgloss.Style
	rule, chip        lipgloss.Style
}

func newStyles(isDark bool) styles {
	c := lipgloss.LightDark(isDark)
	fg := func(light, dark string) lipgloss.Style {
		return lipgloss.NewStyle().Foreground(c(lipgloss.Color(light), lipgloss.Color(dark)))
	}
	return styles{
		brand: fg("#5A3FC0", "#B9A6FF").Bold(true),
		bold:  lipgloss.NewStyle().Bold(true),
		dim:   fg("#8A8A8A", "#6C6C6C"),
		good:  fg("#1A7F37", "#56D364"),
		bad:   fg("#CF222E", "#FF7B72"),
		warn:  fg("#9A6700", "#E3B341"),
		cells: map[warmup.SegmentKind]lipgloss.Style{
			warmup.SegmentOff:       fg("#B0B0B0", "#4A4A4A"),
			warmup.SegmentWork:      fg("#6E7781", "#8B949E"),
			warmup.SegmentPredicted: fg("#0969DA", "#58A6FF"),
			warmup.SegmentArmed:     fg("#1A7F37", "#3FB950"),
		},
		next:   fg("#BC4C00", "#FFA657").Bold(true),
		cursor: lipgloss.NewStyle().Reverse(true),
		now:    fg("#CF222E", "#FF7B72").Bold(true),
		rule:   fg("#D0D7DE", "#30363D"),
		chip:   lipgloss.NewStyle().Reverse(true).Bold(true),
	}
}
