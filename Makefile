# Common tasks. Go comes from upstream/server/go.mod (GOTOOLCHAIN=auto fetches it).
export GOTOOLCHAIN ?= auto
UP := upstream/server
TAG := $(shell git -C upstream describe --tags --exact-match HEAD 2>/dev/null)
IMAGE ?= multica-daemon-bb:local
CONTRACT_ADDR ?= 127.0.0.1:18787

.PHONY: overlay reset patch test test-upstream test-contract image up drills down pins

overlay:            ## copy bb files into upstream + apply the patch
	scripts/apply-overlay.sh

reset:              ## restore the pristine submodule
	scripts/reset-overlay.sh

patch: overlay      ## regenerate patches/register-bb.patch after editing files in upstream/
	cd upstream && git diff > ../patches/register-bb.patch
	@echo "patch: $$(grep -c '^+[^+]' patches/register-bb.patch) added lines"

test: overlay       ## bb unit tests + every daemon test + mock-bb tests
	cd $(UP) && go vet ./pkg/agent ./internal/daemon
	cd $(UP) && go test -race -count=1 ./pkg/agent -run 'BB|MuseApp|LaunchHeader|SupportedType'
	cd $(UP) && go test -count=1 ./internal/daemon
	cd mock-bb && go test -race -count=1 ./...

test-upstream: overlay  ## upstream's full agent + daemon suites (slow; a few are sandbox-sensitive)
	cd $(UP) && go test -count=1 ./pkg/agent ./internal/daemon/...

test-contract: overlay  ## real bb backend against a live mock-bb
	scripts/contract-test.sh $(CONTRACT_ADDR)

image:              ## build the daemon image
	docker build -f Dockerfile.daemon -t $(IMAGE) --build-arg VERSION=$(TAG)-bb .

up:                 ## compose stack: stock Multica + our daemon + mock-bb
	compose/up.sh

drills:             ## scripted failure drills against the compose stack
	compose/drills/run-all.sh

down:               ## stop the stack and delete its volumes + bootstrap state
	cd compose && docker compose --profile ui down -v
	rm -f compose/.state/pat compose/.state/workspace_id

pins:               ## submodule tag == compose image tag
	scripts/check-pins.sh
