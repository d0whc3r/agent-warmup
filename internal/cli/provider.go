package cli

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/d0whc3r/agent-warmup/internal/config"
	"github.com/d0whc3r/agent-warmup/internal/detect"
	"github.com/d0whc3r/agent-warmup/internal/domain"
	"github.com/d0whc3r/agent-warmup/internal/provider"
)

func (a *app) providerCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "provider",
		Short: "List the providers, or configure one (provider ID ...)",
		Long:  "Without a subcommand, provider lists every provider like provider list.",
		Args:  noArgs,
		RunE:  func(*cobra.Command, []string) error { return a.listProviders() },
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "list",
		Short: "List every provider with its state and binary",
		Args:  noArgs,
		RunE:  func(*cobra.Command, []string) error { return a.listProviders() },
	})
	for _, id := range domain.ProviderIDs {
		cmd.AddCommand(a.providerIDCmd(id))
	}
	return cmd
}

func (a *app) listProviders() error {
	cfg, err := a.load()
	if err != nil {
		return err
	}
	var b strings.Builder
	for _, d := range detect.All(a.paths, cfg) {
		pc := cfg.Providers[d.ID]
		fmt.Fprintf(&b, "%s %-9s %-23s enabled=%t  usage=%s  model=%s  bin=%s\n",
			marks[pc.Enabled], d.ID, d.Name, pc.Enabled, provider.Get(d.ID).ProbeKind(), pc.Model, where(d))
	}
	fmt.Fprint(a.out, b.String())
	return nil
}

// where is the found binary path, or why there is none.
func where(d detect.Detection) string {
	if d.Path != "" {
		return d.Path
	}
	if d.Blocked != "" {
		return d.Blocked
	}
	return fmt.Sprintf("not found (looked for %q)", d.Binary)
}

func (a *app) providerIDCmd(id domain.ProviderID) *cobra.Command {
	cmd := &cobra.Command{
		Use:   string(id),
		Short: "Configure " + provider.Get(id).Name(),
		Args:  noArgs,
		RunE:  func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	cmd.AddCommand(
		&cobra.Command{
			Use:   "enable",
			Short: "Enable this provider",
			Args:  noArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				cfg, err := a.load()
				if err != nil {
					return err
				}
				next := config.WithProvider(cfg, id, func(pc *domain.ProviderConfig) { pc.Enabled = true })
				return a.commit(cmd.Context(), next, string(id)+" enabled")
			},
		},
		&cobra.Command{
			Use:   "disable",
			Short: "Disable this provider",
			Args:  noArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				cfg, err := a.load()
				if err != nil {
					return err
				}
				next := config.WithProvider(cfg, id, func(pc *domain.ProviderConfig) { pc.Enabled = false })
				return a.commit(cmd.Context(), next, string(id)+" disabled")
			},
		},
		&cobra.Command{
			Use:               "model NAME",
			Short:             "Set the model (any id the agent CLI accepts)",
			Args:              usageArgs(cobra.ExactArgs(1)),
			ValidArgsFunction: completeModels(id),
			RunE: func(_ *cobra.Command, args []string) error {
				return a.setProvider(id, args[0], func(pc *domain.ProviderConfig) { pc.Model = args[0] }, "model")
			},
		},
		&cobra.Command{
			Use:   "binary PATH",
			Short: "Set the binary path",
			Args:  usageArgs(cobra.ExactArgs(1)),
			RunE: func(_ *cobra.Command, args []string) error {
				return a.setProvider(id, args[0], func(pc *domain.ProviderConfig) { pc.Binary = args[0] }, "binary")
			},
		},
	)
	return cmd
}

func (a *app) setProvider(id domain.ProviderID, value string, edit func(*domain.ProviderConfig), field string) error {
	cfg, err := a.load()
	if err != nil {
		return err
	}
	return a.save(config.WithProvider(cfg, id, edit), fmt.Sprintf("%s %s: %s", id, field, value))
}

func completeModels(id domain.ProviderID) cobra.CompletionFunc {
	return func(_ *cobra.Command, args []string, _ string) ([]cobra.Completion, cobra.ShellCompDirective) {
		if len(args) > 0 {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		return provider.Get(id).ModelChoices(), cobra.ShellCompDirectiveNoFileComp
	}
}

func (a *app) detectCmd() *cobra.Command {
	var apply bool
	cmd := &cobra.Command{
		Use:   "detect",
		Short: "Find the installed agent CLIs",
		Args:  noArgs,
		RunE: func(*cobra.Command, []string) error {
			cfg, err := a.load()
			if err != nil {
				return err
			}
			next, fixed := a.printDetections(cfg)
			switch {
			case !apply:
				fmt.Fprintln(a.out, "\nRun `agent-warmup detect --apply` to save the detected paths.")
				return nil
			case len(fixed) == 0:
				fmt.Fprintln(a.out, "\n✓ nothing to change: every configured binary path is valid")
				return nil
			}
			fmt.Fprintln(a.out)
			return a.save(next, "saved paths for: "+strings.Join(fixed, ", "))
		},
	}
	cmd.Flags().BoolVar(&apply, "apply", false, "save the found path for each provider whose configured path does not work")
	return cmd
}

// printDetections prints one line per provider and returns cfg with the found
// path for each provider whose configured path does not work, and their ids.
func (a *app) printDetections(cfg domain.Config) (domain.Config, []string) {
	next := cfg
	var fixed []string
	var b strings.Builder
	for _, d := range detect.All(a.paths, cfg) {
		fmt.Fprintf(&b, "%s %-9s %s", marks[d.Path != ""], d.ID, where(d))
		if d.Path != "" && !d.ConfiguredOK {
			fmt.Fprintf(&b, "  (config points at %s)", d.Configured)
			next = config.WithProvider(next, d.ID, func(pc *domain.ProviderConfig) { pc.Binary = d.Path })
			fixed = append(fixed, string(d.ID))
		}
		b.WriteString("\n")
	}
	fmt.Fprint(a.out, b.String())
	return next, fixed
}
