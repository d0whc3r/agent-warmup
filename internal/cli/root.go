// Package cli builds the cobra command tree. It and internal/tui are the only
// packages that print to the user.
package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/paths"
	"github.com/d0whc3r/agent-warmup/internal/sysexec"
	"github.com/d0whc3r/agent-warmup/internal/tui"
)

// BuildInfo is set by the linker through cmd/agent-warmup.
type BuildInfo struct {
	Version string
	Commit  string
	Date    string
}

const (
	exitError = 1
	exitUsage = 2
	noTTYNote = "(No terminal found, so agent-warmup prints the status. Run it in a terminal to open the UI.)"
)

// statusError is a non-zero exit status whose cause the command already
// printed, such as a failed arm in run or tick.
type statusError struct{ status int }

func (e statusError) Error() string { return fmt.Sprintf("exit status %d", e.status) }

// usageError is a bad command line: an unknown command, flag, or argument.
type usageError struct{ err error }

func (e usageError) Error() string { return e.err.Error() }
func (e usageError) Unwrap() error { return e.err }

// app is the state every command shares.
type app struct {
	info    BuildInfo
	paths   paths.Paths
	out     io.Writer
	errOut  io.Writer
	verbose bool
}

// Execute runs the command line and returns the process exit status.
func Execute(ctx context.Context, info BuildInfo) int {
	return run(ctx, info, os.Args[1:], os.Stdout, os.Stderr)
}

func run(ctx context.Context, info BuildInfo, args []string, out, errOut io.Writer) int {
	p, err := paths.Resolve()
	if err != nil {
		return exitCode(err, errOut)
	}
	a := &app{info: info, paths: p, out: out, errOut: errOut}
	root := a.rootCmd() //nolint:contextcheck // commands read ctx from cmd.Context(), set by ExecuteContext below
	root.SetArgs(args)
	root.SetOut(out)
	root.SetErr(errOut)
	return exitCode(root.ExecuteContext(ctx), errOut)
}

// exitCode prints err once and maps it to an exit status.
func exitCode(err error, errOut io.Writer) int {
	if err == nil {
		return 0
	}
	var status statusError
	if errors.As(err, &status) {
		return status.status
	}
	// errors.Join puts one error per line, and each line gets the prefix.
	var b strings.Builder
	for line := range strings.SplitSeq(err.Error(), "\n") {
		b.WriteString("agent-warmup: " + line + "\n")
	}
	fmt.Fprint(errOut, b.String())
	var usage usageError
	if errors.As(err, &usage) {
		fmt.Fprintln(errOut, "Run 'agent-warmup --help' for usage.")
		return exitUsage
	}
	return exitError
}

func (a *app) rootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "agent-warmup",
		Short: "Align coding-agent quota windows with your working hours",
		Long:  a.longHelp(),
		// Without a terminal on stdin and stdout, the root command prints the
		// status instead of opening the UI, so scripts and pipes get text.
		RunE:             a.runRoot,
		Args:             noArgs,
		Version:          versionText(a.info),
		SilenceUsage:     true,
		SilenceErrors:    true,
		PersistentPreRun: func(*cobra.Command, []string) { a.setupLog() },
	}
	root.SetVersionTemplate("agent-warmup {{.Version}}\n")
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error { return usageError{err} })
	root.PersistentFlags().BoolVarP(&a.verbose, "verbose", "v", false, "log debug details to stderr")

	root.AddCommand(
		a.statusCmd(), a.usageCmd(), a.runCmd(), a.tickCmd(),
		a.startCmd(), a.stopCmd(), a.restartCmd(), a.logsCmd(),
		a.detectCmd(), a.providerCmd(),
		a.upgradeCmd(), a.uninstallCmd(), a.versionCmd(), a.cleanLegacyCmd(),
	)
	return root
}

func (a *app) longHelp() string {
	text := fmt.Sprintf(`agent-warmup starts the usage window of your AI coding subscriptions before
you start work. Without a command it opens the terminal UI.

Files:
  config   %s
  cache    %s
  logs     %s`, a.paths.Config, a.paths.Cache, a.paths.WarmupLog)
	if runtime.GOOS == "darwin" {
		text += fmt.Sprintf("\n  plist    %s  (label %s)", a.paths.Plist, paths.Label)
	}
	return text
}

func versionText(info BuildInfo) string {
	return fmt.Sprintf("%s (commit %s, built %s)", info.Version, info.Commit, info.Date)
}

// setupLog sends slog to stderr before any command loads the config, which
// logs a created or migrated config file.
func (a *app) setupLog() {
	level := slog.LevelInfo
	if a.verbose {
		level = slog.LevelDebug
	}
	dropTime := func(_ []string, attr slog.Attr) slog.Attr {
		if attr.Key == slog.TimeKey {
			return slog.Attr{}
		}
		return attr
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(a.errOut, &slog.HandlerOptions{Level: level, ReplaceAttr: dropTime})))
}

func (a *app) load() (domain.Config, error) {
	cfg, err := config.Load(a.paths)
	if err != nil {
		return cfg, err
	}
	slog.Debug("loaded config", "path", a.paths.Config, "enabled", cfg.Enabled())
	return cfg, nil
}

func (a *app) runRoot(cmd *cobra.Command, _ []string) error {
	cfg, err := a.load()
	if err != nil {
		return err
	}
	if !sysexec.IsTerminal(os.Stdin) || !sysexec.IsTerminal(a.out) {
		fmt.Fprint(a.out, noTTYNote+"\n\n")
		return a.printStatus(cmd.Context(), cfg, cfg.Enabled())
	}
	return tui.Run(cmd.Context(), tui.Deps{Paths: a.paths, Config: cfg, Actions: a.tuiActions(), Now: time.Now})
}

// usageArgs marks the errors of an argument validator as usage errors.
func usageArgs(validate cobra.PositionalArgs) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if err := validate(cmd, args); err != nil {
			return usageError{err}
		}
		return nil
	}
}

var noArgs = usageArgs(cobra.NoArgs)

// optionalAgent accepts no argument, for every enabled agent, or one agent id.
var optionalAgent = usageArgs(func(_ *cobra.Command, args []string) error {
	if len(args) > 1 {
		return fmt.Errorf("accepts at most one agent, received %d", len(args))
	}
	if len(args) == 1 {
		_, err := domain.ParseProviderID(args[0])
		return err
	}
	return nil
})

// agentOf is the agent optionalAgent accepted, or "" for every enabled agent.
func agentOf(args []string) domain.ProviderID {
	if len(args) == 0 {
		return ""
	}
	return domain.ProviderID(args[0])
}

// agentsOf is the agent of args, or every enabled agent.
func agentsOf(cfg domain.Config, args []string) []domain.ProviderID {
	if id := agentOf(args); id != "" {
		return []domain.ProviderID{id}
	}
	return cfg.Enabled()
}

func completeIDs(_ *cobra.Command, args []string, _ string) ([]cobra.Completion, cobra.ShellCompDirective) {
	if len(args) > 0 {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	ids := make([]cobra.Completion, len(domain.ProviderIDs))
	for i, id := range domain.ProviderIDs {
		ids[i] = string(id)
	}
	return ids, cobra.ShellCompDirectiveNoFileComp
}
