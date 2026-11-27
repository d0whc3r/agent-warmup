package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/d0whc3r/agent-warmup/internal/legacy"
	"github.com/d0whc3r/agent-warmup/internal/selfupdate"
)

func (a *app) upgradeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "upgrade",
		Short: "Replace the binary with the latest release",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			res, err := selfupdate.Upgrade(cmd.Context(), a.info.Version)
			if err != nil {
				return err
			}
			if !res.Updated {
				fmt.Fprintf(a.out, "✓ already on the latest release (%s)\n", res.To)
				return nil
			}
			fmt.Fprintf(a.out, "✓ upgraded %s → %s (%s)\n", res.From, res.To, res.Path)
			return nil
		},
	}
}

func (a *app) uninstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall",
		Short: "Remove the scheduler, tmux sessions, arm scripts, workdir, and cache",
		Long:  "Remove the scheduler, tmux sessions, arm scripts, workdir, and cache. The config and the logs stay.",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			report, err := selfupdate.Uninstall(cmd.Context(), a.paths)
			a.printReport(report)
			if err != nil {
				return err
			}
			fmt.Fprintf(a.out, "\nkept  config  %s\n      logs    %s\n      binary  delete it yourself if you no longer want the CLI\n",
				a.paths.Config, a.paths.LogDir)
			return nil
		},
	}
}

func (a *app) versionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the version, commit, and build date",
		Args:  noArgs,
		RunE: func(*cobra.Command, []string) error {
			fmt.Fprintf(a.out, "agent-warmup %s\n", versionText(a.info))
			return nil
		},
	}
}

// cleanLegacyCmd is what install.sh runs after it installs the binary.
func (a *app) cleanLegacyCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "clean-legacy",
		Short:  "Remove what the TypeScript release left behind",
		Hidden: true,
		Args:   noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			// Load first, so install.sh also converts warmup.env.
			if _, err := a.load(); err != nil {
				return err
			}
			report, err := legacy.Clean(cmd.Context(), a.paths)
			a.printReport(report)
			return err
		},
	}
}
