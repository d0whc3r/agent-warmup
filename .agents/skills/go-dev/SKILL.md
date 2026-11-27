---
name: go-dev
description: Conventions for writing and testing Go code in the agent-warmup repository (errors, context, subprocesses, slog, table tests, stub executables on PATH, t.Setenv and t.TempDir). Use when you add or change any .go file in this repo, write a test, run an external command, or review a Go diff here.
---

# Go in agent-warmup

Read `docs/architecture.md` for the package map and the layer rules first. This skill lists the code rules that the linter cannot enforce.

When a rule here differs from a general Go skill, this skill wins. For depth on one topic, load the matching general skill: `golang-error-handling`, `golang-context`, `golang-concurrency`, `golang-testing`, `golang-safety`, `golang-security`, `golang-lint`, `golang-code-style`, `golang-cli`, or `golang-spf13-cobra`.

## Checks

Run `make check` before you hand back. It runs `fmt-check`, `vet`, `lint`, and `test` (`go test -race -count=1 ./...`). Run `make fmt` to fix formatting. `tools/go.mod` pins the tools, and `go tool` runs them. Do not install them globally.

## Layers

`cli` and `tui` call `warmup`, `scheduler`, `detect`, and `selfupdate`. Those call `provider`, `config`, `cache`, `logs`, and `paths`. Only `cli` and `tui` print to the user. A lower package returns values and errors. It does not print and does not call `os.Exit`.

## Errors

- Wrap with `fmt.Errorf("read %s: %w", path, err)`. Start the message with the action, in lower case, with no trailing period.
- Compare with `errors.Is` and `errors.As`. Never compare error strings.
- Use a sentinel (`var ErrNoLiveProbe = errors.New(...)`) only when a caller branches on it.
- Do not swallow an error. When a caller must continue (a log write inside a tick), log it with `slog.Warn` and continue.
- Validation errors name the configuration key: `providers.codex.work_start: 25 is out of range 0-23`. Join several with `errors.Join`.

## Context and subprocesses

- Put `ctx context.Context` first on every function that starts a process or makes a network call. Local file reads and writes take no context.
- Start processes with `exec.CommandContext(ctx, name, args...)`. Never build a shell string. Pass arguments as a slice.
- Give each external call a timeout with `context.WithTimeout`, and `defer cancel()`.
- Read the exit code with `errors.As(err, &exitErr)` on `*exec.ExitError`.
- Re-invoke this binary with `os.Executable()`, never with `os.Args[0]`.

## Logging and output

- Use `log/slog` for diagnostics. The CLI sets a stderr handler before `config.Load`.
- Write each user-facing line with one `Write` call. Providers run in goroutines, and partial writes interleave.

## Style

- Return early. Use `continue` in loops. Avoid `else` after a `return`.
- Give a value from a spec a named constant (`sessionWindow = 5 * time.Hour`, `armTimeout = 5 * time.Minute`).
- Use a typed option, not a `bool` parameter: `Apply(ctx, scheduler.ModeReload)` reads, `Apply(ctx, true)` does not. Add the type only when two real variants exist.
- Add an interface only when two real implementations exist. `provider.Provider` has seven.
- Keep function names under 30 characters. Do not export a symbol that no other package uses.
- Write a comment only for what the code cannot say.

## Tests

- Use the standard `testing` package. Do not add testify or other assertion libraries.
- Write table tests with `t.Run(tc.name, ...)` when three or more cases share one shape.
- Isolate the filesystem: `t.Setenv("WARMUP_HOME", t.TempDir())`, then `paths.Resolve()`. Never touch the real `~/.agent-warmup`.
- `t.Setenv` makes the test non-parallel. Do not call `t.Parallel()` in a test that sets the environment.
- Fake an external command with a stub script on `PATH`:

```go
func stubCommand(t *testing.T, name, script string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return path
}
```

- Point `TMUX_BIN` at a stub for tmux, and `WARMUP_<ID>_SCRIPT` at a stub arm script. Lower `WARMUP_READY_WAIT` and `WARMUP_RESPONSE_WAIT` to keep tests fast.
- Pass `now time.Time` into time-dependent code, and use fixed times in tests. Do not sleep to wait for a result.
- Put fixtures in `testdata/`. Compare structs with `reflect.DeepEqual`, and print `got` and `want` with `%+v`.
