package provider

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"io/fs"
	"os"

	"github.com/d0whc3r/agent-warmup/internal/atomicfile"
	"github.com/d0whc3r/agent-warmup/internal/paths"
)

// armScriptMode lets only the owner read and run the script.
const armScriptMode = 0o700

var (
	//go:embed scripts/arm-claude.sh
	armClaude []byte
	//go:embed scripts/arm-codex.sh
	armCodex []byte
	//go:embed scripts/arm-kimi.sh
	armKimi []byte
	// arm-opencode.sh serves opencode, zai, and minimax. The credential
	// store of opencode picks the account.
	//go:embed scripts/arm-opencode.sh
	armOpencode []byte
	//go:embed scripts/arm-agy.sh
	armAgy []byte
)

// EnsureArmScript returns the path of prov's arm script. With
// WARMUP_<ID>_SCRIPT set it returns that path untouched. Otherwise it writes
// the embedded script to Home/arm-<id>.sh when the file is missing or differs.
// The write is a rename, so a bash that still reads the old file keeps it.
func EnsureArmScript(p paths.Paths, prov Provider) (string, error) {
	path, overridden := p.ArmScript(prov.ID())
	if overridden {
		return path, nil
	}
	script := prov.ArmScript()
	current, err := os.ReadFile(path)
	if err == nil && bytes.Equal(current, script) {
		return path, nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("read arm script: %w", err)
	}
	if err := atomicfile.Write(path, script); err != nil {
		return "", fmt.Errorf("write arm script: %w", err)
	}
	if err := os.Chmod(path, armScriptMode); err != nil {
		return "", fmt.Errorf("chmod arm script: %w", err)
	}
	return path, nil
}
