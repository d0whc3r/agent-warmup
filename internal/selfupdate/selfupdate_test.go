package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/d0whc3r/agent-warmup/internal/sandbox"
)

const newBinary = "#!/bin/sh\necho v9.9.9\n"

// release serves a latest-release answer and the v9.9.9 assets.
func release(t *testing.T, tagJSON string, status int, sums string) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/latest", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") != "application/vnd.github+json" {
			t.Errorf("Accept = %q", r.Header.Get("Accept"))
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(tagJSON))
	})
	mux.HandleFunc("/download/v9.9.9/"+assetName(), func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(newBinary))
	})
	mux.HandleFunc("/download/v9.9.9/"+checksumsName, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(sums))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	oldAPI, oldBase := releaseAPI, downloadBase
	releaseAPI, downloadBase = srv.URL+"/latest", srv.URL+"/download/"
	t.Cleanup(func() { releaseAPI, downloadBase = oldAPI, oldBase })
}

func goodSums() string {
	sum := sha256.Sum256([]byte(newBinary))
	return "0000000000000000000000000000000000000000000000000000000000000000  other\n" +
		hex.EncodeToString(sum[:]) + "  " + assetName() + "\n"
}

func TestLatestTag(t *testing.T) {
	cases := []struct {
		name, body string
		status     int
		want, err  string
	}{
		{"ok", `{"tag_name":"v9.9.9"}`, http.StatusOK, "v9.9.9", ""},
		{"rate limited", `nope`, http.StatusForbidden, "", "403"},
		{"no tag", `{}`, http.StatusOK, "", "no tag"},
		{"bad tag", `{"tag_name":"../evil;id"}`, http.StatusOK, "", "invalid release tag"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			release(t, tc.body, tc.status, "")
			got, err := latestTag(context.Background())
			if tc.err == "" && (err != nil || got != tc.want) {
				t.Errorf("latestTag = %q, %v", got, err)
			}
			if tc.err != "" && (err == nil || !strings.Contains(err.Error(), tc.err)) {
				t.Errorf("latestTag err = %v, want %q", err, tc.err)
			}
		})
	}
}

func TestInstallReplacesBinary(t *testing.T) {
	release(t, "", http.StatusOK, goodSums())
	target := filepath.Join(t.TempDir(), "agent-warmup")
	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := install(context.Background(), "v9.9.9", target); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(target)
	info, _ := os.Stat(target)
	if err != nil || string(data) != newBinary || info.Mode().Perm() != binaryMode {
		t.Errorf("target = %q, %v, %v", data, info.Mode(), err)
	}
	if entries, _ := os.ReadDir(filepath.Dir(target)); len(entries) != 1 {
		t.Errorf("temp file left behind: %v", entries)
	}
}

func TestInstallRejectsBadChecksum(t *testing.T) {
	for name, sums := range map[string]string{
		"mismatch":  strings.Repeat("a", 64) + "  " + assetName() + "\n",
		"no entry":  goodSums()[:65] + "  other\n",
		"empty sum": "",
	} {
		t.Run(name, func(t *testing.T) {
			release(t, "", http.StatusOK, sums)
			target := filepath.Join(t.TempDir(), "agent-warmup")
			if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := install(context.Background(), "v9.9.9", target); err == nil {
				t.Fatal("install accepted a bad checksum")
			}
			if data, _ := os.ReadFile(target); string(data) != "old" {
				t.Error("the old binary was replaced")
			}
		})
	}
}

func TestUpgradeGuards(t *testing.T) {
	if _, err := Upgrade(context.Background(), "dev"); err == nil || !strings.Contains(err.Error(), "development build") {
		t.Errorf("dev build err = %v", err)
	}
	release(t, `{"tag_name":"v9.9.9"}`, http.StatusOK, "")
	r, err := Upgrade(context.Background(), "9.9.9")
	if err != nil || r.Updated || r.To != "v9.9.9" {
		t.Errorf("same version = %+v, %v", r, err)
	}
}

func TestUninstall(t *testing.T) {
	s := sandbox.New(t)
	t.Setenv("FAKE_LAUNCHCTL_STATUS", "3")
	p := s.Paths
	s.SetTmuxSessions(t, "agent-warmup-claude", "agent-warmup-codex-usage")
	s.SetCrontab(t, "0 0 * * * /usr/bin/backup\n# >>> agent-warmup >>>\nx\n# <<< agent-warmup <<<\n")
	keep := []string{p.Config, p.WarmupLog}
	gone := []string{filepath.Join(p.Home, "arm-claude.sh"), filepath.Join(p.Workdir, "f"), p.Cache, p.Cache + ".lock", p.TickLock}
	for _, f := range append(slices.Clone(keep), gone...) {
		sandbox.WriteExec(t, f, "x")
	}

	r, err := Uninstall(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range keep {
		if _, err := os.Stat(f); err != nil {
			t.Errorf("%s was deleted", f)
		}
	}
	for _, f := range gone {
		if _, err := os.Stat(f); !os.IsNotExist(err) {
			t.Errorf("%s survived", f)
		}
	}
	for _, want := range []string{"tmux session agent-warmup-claude", "tmux session agent-warmup-codex-usage", p.Workdir, p.Cache} {
		if !slices.Contains(r.Actions, want) {
			t.Errorf("actions %q lack %q", r.Actions, want)
		}
	}
	if got := s.Crontab(t); got != "0 0 * * * /usr/bin/backup\n" {
		t.Errorf("crontab = %q", got)
	}
}

// TestUninstallKeepsOutsideWorkdir: WARMUP_WORKDIR may point at a directory
// the user owns, such as a project checkout. Uninstall must not delete it.
func TestUninstallKeepsOutsideWorkdir(t *testing.T) {
	s := sandbox.New(t)
	t.Setenv("FAKE_LAUNCHCTL_STATUS", "3")
	p := s.Paths
	p.Workdir = filepath.Join(s.Root, "projects", "mine")
	file := filepath.Join(p.Workdir, "main.go")
	sandbox.WriteExec(t, file, "x")

	r, err := Uninstall(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatal("uninstall deleted a workdir outside the home")
	}
	if want := "left WARMUP_WORKDIR " + p.Workdir + " in place"; !slices.Contains(r.Notices, want) {
		t.Errorf("notices %q lack %q", r.Notices, want)
	}
}

// TestRedirectToHTTPIsRefused: a redirect must not downgrade the download to
// plain HTTP.
func TestRedirectToHTTPIsRefused(t *testing.T) {
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"v9.9.9"}`))
	}))
	t.Cleanup(plain.Close)
	redirect := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, plain.URL, http.StatusFound)
	}))
	t.Cleanup(redirect.Close)
	old := client.Transport
	client.Transport = redirect.Client().Transport
	t.Cleanup(func() { client.Transport = old })

	if _, err := get(context.Background(), redirect.URL, ""); err == nil || !strings.Contains(err.Error(), "https") {
		t.Errorf("get followed a redirect to http: %v", err)
	}
}

func TestReleaseJSONIsBounded(t *testing.T) {
	release(t, `{"tag_name":"v9.9.9","body":"`+strings.Repeat("x", maxReleaseBytes)+`"}`, http.StatusOK, "")
	if _, err := latestTag(context.Background()); err == nil {
		t.Error("latestTag read a release answer larger than the limit")
	}
}
