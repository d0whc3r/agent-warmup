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

## Testing

```bash
pnpm test            # full suite
pnpm test:coverage   # suite + coverage table (fails below 97% lines / 94% funcs / 85% branches)
pnpm coverage:lcov   # suite + coverage/lcov.info for tooling
```

`dist/` is excluded from the report; `coverage/` is gitignored.

## Releasing

Releases are automatic. Every push to `main` runs CI, builds the four SEA
binaries, then hands them to [semantic-release], which reads the commit history
and publishes a GitHub Release only when the commits warrant one:

| Commit type                      | Version bump |
| -------------------------------- | ------------ |
| `fix:`                           | patch        |
| `feat:`                          | minor        |
| any type + `BREAKING CHANGE:`    | major        |
| `chore:`, `docs:`, `refactor:` … | none         |

Commit messages are enforced at commit time by commitlint via a husky
`commit-msg` hook ([Conventional Commits]). Nothing is tagged or published by
hand.

| Platform            | Asset                       |
| ------------------- | --------------------------- |
| Linux x64           | `agent-warmup-linux-x64`    |
| Linux arm64         | `agent-warmup-linux-arm64`  |
| macOS Intel         | `agent-warmup-darwin-x64`   |
| macOS Apple Silicon | `agent-warmup-darwin-arm64` |

`install.sh` is not a release asset — it is served from `main` and resolves
`releases/latest/download/` itself.
`workflow_dispatch` on `.github/workflows/release.yml` smoke-tests the same
matrix without publishing.

[semantic-release]: https://semantic-release.gitbook.io
[Conventional Commits]: https://www.conventionalcommits.org
