// Package selfupdate replaces the running binary with the latest GitHub
// release, and removes what the tool installed outside its config and logs.
package selfupdate

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/d0whc3r/agent-warmup/internal/sysexec"
)

const (
	repo = "d0whc3r/agent-warmup"
	// devVersion is the version of a build without -ldflags (go run, go build).
	devVersion    = "dev"
	checksumsName = "checksums.txt"
	binaryMode    = 0o755
	apiTimeout    = 15 * time.Second
	fetchTimeout  = 5 * time.Minute
	// maxBinaryBytes caps a download, so a bad server cannot fill the disk.
	maxBinaryBytes = 256 << 20
	// maxReleaseBytes caps the release JSON. GitHub's answer is a few KiB.
	maxReleaseBytes = 1 << 20
	// maxRedirects covers GitHub's hop from a release asset to its CDN.
	maxRedirects = 5
)

// client follows only HTTPS redirects, and at most maxRedirects of them.
var client = &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
	if req.URL.Scheme != "https" {
		return fmt.Errorf("refuse redirect to %s: not https", req.URL.Redacted())
	}
	if len(via) >= maxRedirects {
		return fmt.Errorf("stop after %d redirects", maxRedirects)
	}
	return nil
}}

// Test seams: tests point these at an httptest server.
var (
	releaseAPI   = "https://api.github.com/repos/" + repo + "/releases/latest"
	downloadBase = "https://github.com/" + repo + "/releases/download/"
)

// tagRE also keeps the tag safe to put in a URL path.
var tagRE = regexp.MustCompile(`^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`)

// Result describes an upgrade. Updated is false when the build already is
// the latest release.
type Result struct {
	From, To string
	Path     string
	Updated  bool
}

// assetName is the GoReleaser binary asset for this platform.
func assetName() string {
	return fmt.Sprintf("agent-warmup-%s-%s", runtime.GOOS, runtime.GOARCH)
}

// Upgrade downloads the latest release asset, checks it against
// checksums.txt, and renames it over the running binary.
func Upgrade(ctx context.Context, version string) (Result, error) {
	r := Result{From: version}
	if version == devVersion {
		return r, errors.New("this is a development build (version dev). Install a release with install.sh instead")
	}
	tag, err := latestTag(ctx)
	if err != nil {
		return r, err
	}
	r.To = tag
	if strings.TrimPrefix(tag, "v") == strings.TrimPrefix(version, "v") {
		return r, nil
	}
	if r.Path, err = sysexec.Self(); err != nil {
		return r, err
	}
	if err := install(ctx, tag, r.Path); err != nil {
		return r, err
	}
	r.Updated = true
	return r, nil
}

func latestTag(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, apiTimeout)
	defer cancel()
	body, err := get(ctx, releaseAPI, "application/vnd.github+json")
	if err != nil {
		return "", err
	}
	defer body.Close()

	var release struct {
		TagName string `json:"tag_name"`
	}
	data, err := io.ReadAll(io.LimitReader(body, maxReleaseBytes+1))
	if err != nil {
		return "", fmt.Errorf("read latest release: %w", err)
	}
	if len(data) > maxReleaseBytes {
		return "", fmt.Errorf("latest release answer is larger than %d bytes", maxReleaseBytes)
	}
	if err := json.Unmarshal(data, &release); err != nil {
		return "", fmt.Errorf("decode latest release: %w", err)
	}
	if release.TagName == "" {
		return "", errors.New("the latest release has no tag")
	}
	if !tagRE.MatchString(release.TagName) {
		return "", fmt.Errorf("invalid release tag %q", release.TagName)
	}
	return release.TagName, nil
}

// install downloads tag's asset to a temp file next to target, verifies its
// sha256, and renames it over target. The running process keeps the old
// inode, so replacing a running binary is safe.
func install(ctx context.Context, tag, target string) error {
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	asset := assetName()

	want, err := checksum(ctx, tag, asset)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".agent-warmup-*")
	if err != nil {
		return fmt.Errorf("create temp file next to %s: %w", target, err)
	}
	defer os.Remove(tmp.Name())

	got, err := download(ctx, downloadBase+tag+"/"+asset, tmp)
	if closeErr := tmp.Close(); err == nil && closeErr != nil {
		err = fmt.Errorf("close %s: %w", tmp.Name(), closeErr)
	}
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("checksum mismatch for %s: want %s, got %s", asset, want, got)
	}
	if err := os.Chmod(tmp.Name(), binaryMode); err != nil {
		return fmt.Errorf("chmod %s: %w", tmp.Name(), err)
	}
	if err := os.Rename(tmp.Name(), target); err != nil {
		return fmt.Errorf("replace %s: %w", target, err)
	}
	return nil
}

// checksum reads asset's sha256 from the release's checksums.txt, whose
// lines are "<sha256>  <name>".
func checksum(ctx context.Context, tag, asset string) (string, error) {
	body, err := get(ctx, downloadBase+tag+"/"+checksumsName, "")
	if err != nil {
		return "", err
	}
	defer body.Close()
	scanner := bufio.NewScanner(body)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && fields[1] == asset && len(fields[0]) == sha256.Size*2 {
			return strings.ToLower(fields[0]), nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("read %s: %w", checksumsName, err)
	}
	return "", fmt.Errorf("%s of %s has no entry for %s", checksumsName, tag, asset)
}

// download writes url to w and returns the hex sha256 of what it wrote.
func download(ctx context.Context, url string, w io.Writer) (string, error) {
	body, err := get(ctx, url, "")
	if err != nil {
		return "", err
	}
	defer body.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(w, h), io.LimitReader(body, maxBinaryBytes+1))
	if err != nil {
		return "", fmt.Errorf("download %s: %w", url, err)
	}
	if n > maxBinaryBytes {
		return "", fmt.Errorf("download %s: larger than %d bytes", url, maxBinaryBytes)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// get returns the body of a 2xx answer. The caller closes it.
func get(ctx context.Context, url, accept string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
	if err != nil {
		return nil, fmt.Errorf("build request for %s: %w", url, err)
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", url, err)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		resp.Body.Close()
		return nil, fmt.Errorf("get %s: %s", url, resp.Status)
	}
	return resp.Body, nil
}
