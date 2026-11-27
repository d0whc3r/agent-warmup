# Development

You need Go, at the version in `go.mod`, and `make`. `tools/go.mod` pins the linters and scanners, and `go tool` runs them, so you install nothing else. Run `make check` before you open a pull request. Give the pull request a [Conventional Commits](https://www.conventionalcommits.org) title, because release-please computes the release from it.

## Contents

- [Build and run](#build-and-run)
- [Checks](#checks)
- [Releases](#releases)
- [Dev tools](#dev-tools)

## Build and run

```bash
git clone https://github.com/d0whc3r/agent-warmup.git
cd agent-warmup
make build                 # writes bin/agent-warmup
make run ARGS="status"     # builds, then runs bin/agent-warmup status
make install               # installs into $(go env GOPATH)/bin
```

Set `WARMUP_HOME` to a scratch directory to keep a dev build away from your real `~/.agent-warmup`.

See [architecture](architecture.md) for the package map.

## Checks

Run `make` to list every target.

| Target | What it does |
| --- | --- |
| `make check` | Runs `fmt-check`, `vet`, `lint`, and `test`. CI runs the same checks. |
| `make test` | `go test -race -count=1 ./...` |
| `make cover` | Writes `coverage.out` and prints the coverage of each function. |
| `make lint` | Runs [golangci-lint](https://golangci-lint.run) with `.golangci.yml`. |
| `make fmt` | Formats the code with gofumpt and goimports. `make fmt-check` only reports. |
| `make vet` | `go vet ./...` |
| `make vuln` | Runs [govulncheck](https://go.dev/doc/security/vuln/) on the module. |
| `make tidy-check` | Fails when `go.mod` or `tools/go.mod` is not tidy. |
| `make snapshot` | Builds all release binaries into `dist/` without publishing. Needs [GoReleaser](https://goreleaser.com/install/). |
| `make clean` | Removes `bin/`, `dist/`, and `coverage.out`. |

Tests use only the standard `testing` package. They set `WARMUP_HOME` to a temp directory. They also put stub executables for tmux, launchctl, crontab, and the agent CLIs on `PATH`. Thus, the tests never touch your real setup.

CI (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`. It runs these jobs:

- Build, vet, and race tests on Ubuntu and macOS.
- golangci-lint.
- govulncheck.
- A `go mod tidy` check.
- `goreleaser check`.

A separate workflow checks the pull request title.

## Releases

Releases are automatic. [release-please](https://github.com/googleapis/release-please) and [GoReleaser](https://goreleaser.com) run in `.github/workflows/release.yml` on every push to `main`.

1. release-please reads the Conventional Commits since the last tag and keeps a release pull request open. The pull request updates `CHANGELOG.md` and `.release-please-manifest.json`.
2. When you merge the release pull request, release-please tags `vX.Y.Z` and creates the GitHub release.
3. GoReleaser then builds the four binaries and uploads them with `checksums.txt` to that release.

| Commit type | Version change |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` or a `BREAKING CHANGE:` footer | major |
| `chore:`, `docs:`, `refactor:`, `test:`, `ci:` | none |

Release assets:

| Platform | Asset |
| --- | --- |
| Linux amd64 | `agent-warmup-linux-amd64` |
| Linux arm64 | `agent-warmup-linux-arm64` |
| macOS Intel | `agent-warmup-darwin-amd64` |
| macOS Apple Silicon | `agent-warmup-darwin-arm64` |
| Checksums | `checksums.txt` (sha256) |

`install.sh` and `agent-warmup upgrade` download these names, so do not rename them in `.goreleaser.yaml`. The Go linker ad-hoc signs the macOS arm64 binary. Apple does not notarize the binaries. Thus, Gatekeeper can block a downloaded binary until the user allows it.

`install.sh` is not a release asset. The install command reads it from the `main` branch. The script downloads from `releases/latest` or from the tag in `VERSION`.

## Dev tools

`tools/go.mod` is a separate module that pins golangci-lint and govulncheck with `tool` directives. See [Go tool dependencies](https://go.dev/doc/modules/managing-dependencies#tools). The Makefile runs them with `go tool -modfile=tools/go.mod`. To update one:

```bash
cd tools && go get -tool github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest
```

CI reads the golangci-lint version from `tools/go.mod`, so the local and CI versions stay the same. Renovate proposes updates for both Go modules and for the GitHub Actions, and runs `go mod tidy` on each update. The workflows pin each GitHub Action to a full commit SHA.

GoReleaser is not a Go tool dependency, because its module graph is very large. Install the binary from [goreleaser.com](https://goreleaser.com/install/) to run `make snapshot`. CI pins its version in `GORELEASER_VERSION` in `ci.yml` and `release.yml`.

The agent skills for this repository are in `.agents/skills/`, and `.claude/skills/` links to them. `go-dev` holds the Go conventions, and `bubbletea-v2` holds the terminal UI conventions.
