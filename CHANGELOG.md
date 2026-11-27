# Changelog

## [2.0.0](https://github.com/d0whc3r/agent-warmup/compare/v1.3.0...v2.0.0) (2026-11-27)


### ⚠ BREAKING CHANGES

* the configuration moves from warmup.env to config.toml (migrated once, warmup.env.bak kept). Fixed mode, the default agent, the scheduler choice, the tmux session name, and the tick interval are no longer configurable. Release assets are named agent-warmup-<os>-<arch> with amd64 instead of x64, and checksums.txt replaces SHA256SUMS.

### Features

* rewrite agent-warmup in Go ([#27](https://github.com/d0whc3r/agent-warmup/issues/27)) ([9957e5b](https://github.com/d0whc3r/agent-warmup/commit/9957e5ba88b56c6df6881276dd4b59a141dec345))
