package provider

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/domain"
)

// opencode maps the week's spend from `opencode stats` onto the weekly cap.
// opencode cannot report the five-hour window, so the cache decides it.
type opencode struct{ base }

const (
	weeklyCapUSD         = 30
	statsTimeout         = 10 * time.Second
	versionTimeout       = 10 * time.Second
	versionExitTolerated = 1
	// A boxed model block has six rows (Messages ... Cost). Ten leaves spare
	// rows without reaching the Cost row of the next model.
	costRowLookahead = 10
)

var (
	dollarAmount = regexp.MustCompile(`\$\s*(\d[0-9,]*(?:\.\d+)?)`)
	usdAmount    = regexp.MustCompile(`(?i)USD\s*(\d[0-9,]*(?:\.\d+)?)`)
	costRow      = regexp.MustCompile(`(?i)\bCost\b`)
)

func (opencode) ProbeKind() ProbeKind { return ProbeLive }

func (opencode) Decide(pc ProbeContext, u domain.Usage, entry domain.CacheEntry) domain.Decision {
	if d, ok := decideCache(pc, u, entry); ok {
		return d
	}
	return domain.Decision{Action: domain.ActionWarm, Reason: "no active window probe available"}
}

// Probe runs `opencode stats --days 7 --models 1`. No recorded spend for the
// model gives an inferred snapshot, so the cache decides the window.
func (opencode) Probe(ctx context.Context, pc ProbeContext) (domain.Usage, error) {
	binary := pc.Paths.ExpandHome(pc.Cfg.Binary)
	if err := checkRuns(ctx, binary); err != nil {
		return domain.Usage{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, statsTimeout)
	defer cancel()
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, binary, "stats", "--days", "7", "--models", "1")
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return domain.Usage{}, fmt.Errorf("opencode stats: %w", err)
	}

	cost, ok := parseStatsCost(stdout.String()+stderr.String(), pc.Cfg.Model)
	if !ok {
		return domain.Usage{CapturedAt: pc.Now, Inferred: true}, nil
	}
	pct := min(100, int(math.Round(cost/weeklyCapUSD*100)))
	return domain.Usage{Week: &domain.LimitBlock{Pct: &pct}, CapturedAt: pc.Now}, nil
}

// checkRuns runs `<binary> --version`. Exit 0 or 1 means that the binary runs.
func checkRuns(ctx context.Context, binary string) error {
	ctx, cancel := context.WithTimeout(ctx, versionTimeout)
	defer cancel()
	err := exec.CommandContext(ctx, binary, "--version").Run()
	var exit *exec.ExitError
	if err == nil || (errors.As(err, &exit) && exit.ExitCode() == versionExitTolerated) {
		return nil
	}
	return fmt.Errorf("opencode binary %s does not run: %w", binary, err)
}

// parseStatsCost finds the USD spend of model. The needle is the model after
// its first "/". The flat layout (opencode <= 1.17) puts the amount on the
// model line. The boxed layout (>= 1.18) puts it on a Cost row below.
func parseStatsCost(text, model string) (float64, bool) {
	needle := model
	if _, after, found := strings.Cut(model, "/"); found {
		needle = after
	}
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if !strings.Contains(line, needle) {
			continue
		}
		if cost, ok := parseAmount(line); ok {
			return cost, true
		}
		for _, row := range lines[i+1 : min(len(lines), i+1+costRowLookahead)] {
			if !costRow.MatchString(row) {
				continue
			}
			if cost, ok := parseAmount(row); ok {
				return cost, true
			}
		}
	}
	return 0, false
}

// parseAmount reads "$0.12", "$1,234.50", or "USD 4.56" anywhere on line.
func parseAmount(line string) (float64, bool) {
	m := dollarAmount.FindStringSubmatch(line)
	if m == nil {
		m = usdAmount.FindStringSubmatch(line)
	}
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseFloat(strings.ReplaceAll(m[1], ",", ""), 64)
	return n, err == nil
}
