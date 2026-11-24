default: build-exeuntu

build-exeuntu: ## Build the exeuntu Docker image locally
	@echo "Building exeuntu Docker image..."
	NPM_TOKEN="$${NPM_TOKEN:-$$(gh auth token)}" \
		docker build --secret id=npm_token,env=NPM_TOKEN -t ghcr.io/containmentzone/exeuntu:latest .
	@echo "✓ Image built locally as ghcr.io/containmentzone/exeuntu:latest"

build: build-exeuntu

run: build-exeuntu
	docker run -it \
	  --cap-add=ALL \
	  --security-opt seccomp=unconfined \
	  --security-opt apparmor=unconfined \
	  --cgroupns private \
	  --tmpfs /run \
	  --tmpfs /run/lock \
	  --tmpfs /tmp \
	  --tmpfs /sys/fs/cgroup:rw \
	  ghcr.io/containmentzone/exeuntu:latest

run-bash: build-exeuntu
	docker run -it \
	  --cap-add=ALL \
	  --security-opt seccomp=unconfined \
	  --security-opt apparmor=unconfined \
	  --cgroupns private \
	  --tmpfs /run \
	  --tmpfs /run/lock \
	  --tmpfs /tmp \
	  --tmpfs /sys/fs/cgroup:rw \
	  ghcr.io/containmentzone/exeuntu:latest bash
