# Development

Requires Node.js 24+ and pnpm.

```bash
git clone https://github.com/d0whc3r/agent-warmup.git
cd agent-warmup
pnpm install
pnpm link --global
agent-warmup status
```

`pnpm build` bundles the CLI into `dist/`. On Node 26+, `pnpm build:sea` builds
the standalone binary at `dist/agent-warmup`.

## Releasing

Push a version tag. GitHub Actions builds the four SEA binaries, attaches them
to the GitHub Release for that tag, and uploads `install.sh` so the curl
installer can fetch that release:

```bash
git tag v1.2.3
git push origin v1.2.3
```

| Platform            | Asset                       |
| ------------------- | --------------------------- |
| Linux x64           | `agent-warmup-linux-x64`    |
| Linux arm64         | `agent-warmup-linux-arm64`  |
| macOS Intel         | `agent-warmup-darwin-x64`   |
| macOS Apple Silicon | `agent-warmup-darwin-arm64` |

Tags with a hyphen (`v1.2.3-rc.1`) are published as GitHub prereleases.
`workflow_dispatch` on `.github/workflows/release.yml` smoke-tests the same
matrix without publishing.
