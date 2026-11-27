# Developer tasks. Run `make` to list them.
# tools/go.mod pins the tools and `go tool` runs them, so Go is the only prerequisite.
# GoReleaser is the exception: install it from https://goreleaser.com/install/ for `make snapshot`.

BINARY  := agent-warmup
PKG     := ./cmd/agent-warmup
BIN_DIR := bin
GO_TOOL := go tool -modfile=tools/go.mod

VERSION ?= $(or $(shell git describe --tags --always --dirty 2>/dev/null | sed "s/^v//"),dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT) -X main.date=$(DATE)

export CGO_ENABLED := 0

.DEFAULT_GOAL := help
.PHONY: help build install run test cover lint fmt fmt-check vet vuln tidy-check snapshot clean check

help: ## Show this help
	@awk 'BEGIN { FS = ":.*## " } /^[a-z-]+:.*## / { printf "  %-11s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: ## Build bin/agent-warmup with version info
	go build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BINARY) $(PKG)

install: ## Install agent-warmup into GOBIN (or GOPATH/bin)
	go install -trimpath -ldflags "$(LDFLAGS)" $(PKG)

run: build ## Build and run. Pass arguments with ARGS="status"
	./$(BIN_DIR)/$(BINARY) $(ARGS)

test: ## Run the tests with the race detector
	CGO_ENABLED=1 go test -race -count=1 ./...

cover: ## Write coverage.out and print the per-function summary
	go test -count=1 -covermode=atomic -coverprofile=coverage.out ./...
	go tool cover -func=coverage.out

lint: ## Run golangci-lint
	$(GO_TOOL) golangci-lint run

fmt: ## Format the code (gofumpt + goimports)
	$(GO_TOOL) golangci-lint fmt

fmt-check: ## Fail when a file is not formatted
	$(GO_TOOL) golangci-lint fmt --diff

vet: ## Run go vet
	go vet ./...

vuln: ## Scan dependencies for known vulnerabilities
	$(GO_TOOL) govulncheck ./...

tidy-check: ## Fail when go.mod or go.sum is not tidy
	go mod tidy -diff
	cd tools && go mod tidy -diff

snapshot: ## Build release artifacts locally into dist/ (needs goreleaser)
	goreleaser release --snapshot --clean

clean: ## Remove build and coverage output
	command rm -rf $(BIN_DIR) dist coverage.out

check: fmt-check vet lint test ## Run every check that CI runs on a pull request
