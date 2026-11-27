// Package atomicfile writes a file through a temp file and a rename, so readers
// never see a partial write.
package atomicfile

import (
	"fmt"
	"os"
	"path/filepath"
)

const (
	DirMode  = 0o700
	FileMode = 0o600
)

// Write creates the parent directory with DirMode and replaces path with data,
// readable only by the owner.
func Write(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, DirMode); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file for %s: %w", path, err)
	}
	defer os.Remove(tmp.Name())

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", tmp.Name(), err)
	}
	if err := tmp.Chmod(FileMode); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod %s: %w", tmp.Name(), err)
	}
	// Without the sync, a crash after the rename can leave an empty file.
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync %s: %w", tmp.Name(), err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close %s: %w", tmp.Name(), err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("replace %s: %w", path, err)
	}
	return nil
}
